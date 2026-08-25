package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"
)

// YellowCardSender is the narrow provider boundary for a documented Send
// request. It deliberately returns a provider reference and lifecycle status;
// neither response constitutes settlement finality.
type YellowCardSender interface {
	SubmitSend(context.Context, YellowCardSend) (YellowCardSendResult, error)
}

// YellowCardSend is the minimum normalised request accepted by the provider
// adapter. Sensitive source KYC data is supplied only in the request at the
// trusted payment-engine boundary and is never logged or persisted by this
// adapter.
type YellowCardSend struct {
	SequenceID   string
	CustomerUID  string
	CustomerType string // retail | institution
	Reason       string
	Amount       *int64 // USD minor/whole units as defined by the provider channel
	LocalAmount  *int64
	ChannelID    string
	ChannelType  string // bank | momo when ChannelID is absent
	Country      string
	Currency     string
	Sender       YellowCardSenderDetails
	Destination  YellowCardDestination
	ForceAccept  bool
}

type YellowCardSenderDetails struct {
	Name         string
	Country      string
	Phone        string
	Address      string
	DateOfBirth  string
	Email        string
	IDNumber     string
	IDType       string
	BusinessID   string
	BusinessName string
}

type YellowCardDestination struct {
	AccountNumber string
	AccountType   string // bank | momo
	NetworkID     string
	AccountName   string
	PhoneNumber   string
}

// YellowCardSendResult contains only the provider-created request identity and
// its provisional state. A webhook plus independent ledger reconciliation is
// required before any lifecycle can progress beyond provider-pending evidence.
type YellowCardSendResult struct {
	Reference  string
	SequenceID string
	Status     string
	ExpiresAt  string
}

type yellowCardSendRequest struct {
	SequenceID   string                  `json:"sequenceId"`
	Reason       string                  `json:"reason"`
	Sender       YellowCardSenderDetails `json:"sender"`
	Destination  YellowCardDestination   `json:"destination"`
	CustomerUID  string                  `json:"customerUID"`
	CustomerType string                  `json:"customerType"`
	ForceAccept  bool                    `json:"forceAccept"`
	Amount       *int64                  `json:"amount,omitempty"`
	LocalAmount  *int64                  `json:"localAmount,omitempty"`
	ChannelID    string                  `json:"channelId,omitempty"`
	ChannelType  string                  `json:"channelType,omitempty"`
	Country      string                  `json:"country,omitempty"`
	Currency     string                  `json:"currency,omitempty"`
}

type yellowCardSendResponse struct {
	ID         string `json:"id"`
	SequenceID string `json:"sequenceId"`
	Status     string `json:"status"`
	ExpiresAt  string `json:"expiresAt"`
}

func nonBlank(value string, field string, maximum int) error {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Errorf("Yellow Card send %s is required", field)
	}
	if !utf8.ValidString(trimmed) || len(trimmed) > maximum {
		return fmt.Errorf("Yellow Card send %s is invalid", field)
	}
	return nil
}

func validateYellowCardSend(send YellowCardSend) error {
	if err := nonBlank(send.SequenceID, "sequence id", 128); err != nil {
		return err
	}
	if err := nonBlank(send.CustomerUID, "customer UID", 255); err != nil {
		return err
	}
	if err := nonBlank(send.Reason, "reason", 255); err != nil {
		return err
	}
	if send.ForceAccept {
		return errors.New("Yellow Card forceAccept is prohibited; a separate approved acceptance step is required")
	}
	if (send.Amount == nil && send.LocalAmount == nil) || (send.Amount != nil && send.LocalAmount != nil) {
		return errors.New("exactly one of Yellow Card amount or localAmount is required")
	}
	if send.Amount != nil && *send.Amount <= 0 || send.LocalAmount != nil && *send.LocalAmount <= 0 {
		return errors.New("Yellow Card send amount must be positive")
	}
	if send.CustomerType != "retail" && send.CustomerType != "institution" {
		return errors.New("Yellow Card customer type must be retail or institution")
	}
	if err := nonBlank(send.Destination.AccountNumber, "destination account number", 255); err != nil {
		return err
	}
	if send.Destination.AccountType != "bank" && send.Destination.AccountType != "momo" {
		return errors.New("Yellow Card destination account type must be bank or momo")
	}
	if err := nonBlank(send.Destination.NetworkID, "destination network id", 255); err != nil {
		return err
	}
	if err := nonBlank(send.Destination.AccountName, "destination account name", 255); err != nil {
		return err
	}
	if send.CustomerType == "institution" {
		if err := nonBlank(send.Sender.BusinessID, "sender business id", 255); err != nil {
			return err
		}
		if err := nonBlank(send.Sender.BusinessName, "sender business name", 255); err != nil {
			return err
		}
	} else {
		for field, value := range map[string]string{
			"sender name": send.Sender.Name, "sender country": send.Sender.Country,
			"sender phone": send.Sender.Phone, "sender address": send.Sender.Address,
			"sender date of birth": send.Sender.DateOfBirth, "sender email": send.Sender.Email,
			"sender id number": send.Sender.IDNumber, "sender id type": send.Sender.IDType,
		} {
			if err := nonBlank(value, field, 255); err != nil {
				return err
			}
		}
	}
	if strings.TrimSpace(send.ChannelID) == "" {
		if send.ChannelType != "bank" && send.ChannelType != "momo" {
			return errors.New("Yellow Card channel id or supported channel type is required")
		}
		if err := nonBlank(send.Country, "country for channel type", 3); err != nil {
			return err
		}
		if err := nonBlank(send.Currency, "currency for channel type", 3); err != nil {
			return err
		}
	}
	return nil
}

// SubmitSend creates a provider request that awaits acceptance. It never sets
// forceAccept, does not treat a 2xx response as a completed payment, and does
// not expose the sensitive response body outside this adapter.
func (c *YellowCardClient) SubmitSend(ctx context.Context, send YellowCardSend) (YellowCardSendResult, error) {
	if c == nil {
		return YellowCardSendResult{}, errors.New("Yellow Card sender is unavailable")
	}
	if err := validateYellowCardSend(send); err != nil {
		return YellowCardSendResult{}, err
	}
	body, err := json.Marshal(yellowCardSendRequest{
		SequenceID: send.SequenceID, Reason: send.Reason, Sender: send.Sender,
		Destination: send.Destination, CustomerUID: send.CustomerUID,
		CustomerType: send.CustomerType, ForceAccept: false, Amount: send.Amount,
		LocalAmount: send.LocalAmount, ChannelID: send.ChannelID, ChannelType: send.ChannelType,
		Country: send.Country, Currency: send.Currency,
	})
	if err != nil {
		return YellowCardSendResult{}, fmt.Errorf("encode Yellow Card send: %w", err)
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/send"
	endpoint.RawPath = ""
	timestamp := c.now().UTC().Format("2006-01-02T15:04:05.999999999Z07:00")
	digest := sha256.Sum256(body)
	message := []byte(timestamp + endpoint.EscapedPath() + http.MethodPost + base64.StdEncoding.EncodeToString(digest[:]))
	apiKey, signature, err := c.signer.SignYellowCard(ctx, message)
	if err != nil || strings.TrimSpace(apiKey) == "" || strings.TrimSpace(signature) == "" {
		return YellowCardSendResult{}, errors.New("Yellow Card request signing is unavailable")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return YellowCardSendResult{}, fmt.Errorf("create Yellow Card send request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-YC-Timestamp", timestamp)
	request.Header.Set("Authorization", "YcHmacV1 "+apiKey+":"+signature)
	response, err := c.http.Do(request)
	if err != nil {
		return YellowCardSendResult{}, errors.New("Yellow Card send endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return YellowCardSendResult{}, fmt.Errorf("Yellow Card send was not accepted: HTTP %d", response.StatusCode)
	}
	var decoded yellowCardSendResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, 256*1024))
	if err := decoder.Decode(&decoded); err != nil {
		return YellowCardSendResult{}, errors.New("Yellow Card send response was not valid JSON")
	}
	if strings.TrimSpace(decoded.ID) == "" || decoded.SequenceID != send.SequenceID || strings.TrimSpace(decoded.Status) == "" {
		return YellowCardSendResult{}, errors.New("Yellow Card send response does not match the submitted request")
	}
	return YellowCardSendResult{Reference: decoded.ID, SequenceID: decoded.SequenceID, Status: decoded.Status, ExpiresAt: decoded.ExpiresAt}, nil
}
