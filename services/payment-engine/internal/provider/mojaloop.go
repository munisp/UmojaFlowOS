package provider

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// MojaloopInstruction represents a previously authorised FSPIOP request. It
// cannot be derived from a payment order alone: the Interledger packet and
// condition must come from an authorised quote/fulfilment process, and the
// UUID is the FSPIOP-wide idempotency and callback correlation reference.
type MojaloopInstruction struct {
	InstructionID string
	Corridor      string
	Amount        string
	Currency      string
	PayerFSP      string
	PayeeFSP      string
	Expiration    time.Time
	ILPPacket     string
	Condition     string
}

type MojaloopTransferStatus struct {
	TransferID    string `json:"transferId"`
	TransferState string `json:"transferState"`
}

type MojaloopClient interface {
	// SubmitTransfer returns only an accepted asynchronous request reference.
	// It never represents clearing, settlement, or provider finality.
	SubmitTransfer(context.Context, MojaloopInstruction) (string, error)
	// QueryTransfer is read-only and returns provider-reported transfer state.
	QueryTransfer(context.Context, MojaloopInstruction) (MojaloopTransferStatus, error)
}

type DisabledMojaloopClient struct{}

func (DisabledMojaloopClient) SubmitTransfer(context.Context, MojaloopInstruction) (string, error) {
	return "", errors.New("mojaloop provider is not configured and transfer submission is disabled")
}

func (DisabledMojaloopClient) QueryTransfer(context.Context, MojaloopInstruction) (MojaloopTransferStatus, error) {
	return MojaloopTransferStatus{}, errors.New("mojaloop provider is not configured and transfer lookup is disabled")
}

var (
	fspiopIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	uuidPattern     = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
)

var corridorCurrency = map[string]string{
	"NIGERIA_NGN":      "NGN",
	"KENYA_KES":        "KES",
	"SOUTH_AFRICA_ZAR": "ZAR",
}

// ValidateInstruction rejects incomplete, malformed or unsupported FSPIOP
// transfer requests before any network call. It deliberately does not decide
// whether a payment may be sent; provider activation, policy, credentials and
// a workflow activity are separate authority gates.
func ValidateInstruction(instruction MojaloopInstruction) error {
	if !uuidPattern.MatchString(instruction.InstructionID) {
		return errors.New("mojaloop instruction id must be a UUID")
	}
	expectedCurrency, validCorridor := corridorCurrency[instruction.Corridor]
	if !validCorridor || instruction.Currency != expectedCurrency {
		return errors.New("mojaloop corridor and currency are not a supported pair")
	}
	amount, ok := new(big.Rat).SetString(instruction.Amount)
	if !ok || amount.Sign() <= 0 {
		return errors.New("mojaloop amount must be a positive decimal")
	}
	if !fspiopIDPattern.MatchString(instruction.PayerFSP) || !fspiopIDPattern.MatchString(instruction.PayeeFSP) || instruction.PayerFSP == instruction.PayeeFSP {
		return errors.New("mojaloop payer and payee FSP identifiers are required and must differ")
	}
	if instruction.Expiration.IsZero() || !instruction.Expiration.After(time.Now().UTC()) {
		return errors.New("mojaloop expiration must be in the future")
	}
	if err := validateILPCryptographicFields(instruction.ILPPacket, instruction.Condition); err != nil {
		return err
	}
	return nil
}

// MojaloopSigner delegates the request-specific FSPIOP signature to a
// deployment-approved signing boundary such as HSM-backed key management. The
// HTTP adapter never receives a private key or provider credential.
type MojaloopSigner interface {
	SignFSPIOP(ctx context.Context, method, requestURI string, body []byte) (string, error)
}

type MojaloopConfig struct {
	BaseURL               string
	SourceFSP             string
	Signer                MojaloopSigner
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
}

type FSPIOPMojaloopClient struct {
	baseURL   *url.URL
	sourceFSP string
	signer    MojaloopSigner
	http      *http.Client
}

func NewFSPIOPMojaloopClient(config MojaloopConfig) (*FSPIOPMojaloopClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("mojaloop base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("mojaloop transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if !fspiopIDPattern.MatchString(config.SourceFSP) {
		return nil, errors.New("mojaloop source FSP identifier is invalid")
	}
	if config.Signer == nil {
		return nil, errors.New("mojaloop FSPIOP signer is required")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &FSPIOPMojaloopClient{baseURL: baseURL, sourceFSP: config.SourceFSP, signer: config.Signer, http: client}, nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

type fspiopTransferRequest struct {
	TransferID string `json:"transferId"`
	PayerFSP   string `json:"payerFsp"`
	PayeeFSP   string `json:"payeeFsp"`
	Amount     struct {
		Currency string `json:"currency"`
		Amount   string `json:"amount"`
	} `json:"amount"`
	Expiration string `json:"expiration"`
	ILPPacket  string `json:"ilpPacket"`
	Condition  string `json:"condition"`
}

func (c *FSPIOPMojaloopClient) QueryTransfer(ctx context.Context, instruction MojaloopInstruction) (MojaloopTransferStatus, error) {
	if c == nil || c.baseURL == nil || c.signer == nil || strings.TrimSpace(c.sourceFSP) == "" {
		return MojaloopTransferStatus{}, errors.New("mojaloop client is not configured")
	}
	if err := ValidateInstruction(instruction); err != nil {
		return MojaloopTransferStatus{}, err
	}
	if instruction.PayerFSP != c.sourceFSP {
		return MojaloopTransferStatus{}, errors.New("mojaloop instruction payer does not match configured source FSP")
	}
	requestURI := "/transfers/" + url.PathEscape(instruction.InstructionID)
	signature, err := c.signer.SignFSPIOP(ctx, http.MethodGet, requestURI, nil)
	if err != nil || strings.TrimSpace(signature) == "" {
		return MojaloopTransferStatus{}, errors.New("mojaloop status lookup signature is unavailable")
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: requestURI})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return MojaloopTransferStatus{}, fmt.Errorf("create Mojaloop status request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.interoperability.transfers+json;version=1.1")
	request.Header.Set("FSPIOP-Source", c.sourceFSP)
	request.Header.Set("FSPIOP-URI", requestURI)
	request.Header.Set("FSPIOP-HTTP-Method", http.MethodGet)
	request.Header.Set("FSPIOP-Signature", signature)
	response, err := c.http.Do(request)
	if err != nil {
		return MojaloopTransferStatus{}, errors.New("mojaloop status endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return MojaloopTransferStatus{}, fmt.Errorf("mojaloop status lookup failed: HTTP %d", response.StatusCode)
	}
	var status MojaloopTransferStatus
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&status); err != nil {
		return MojaloopTransferStatus{}, errors.New("mojaloop status response was not valid JSON")
	}
	if status.TransferID != instruction.InstructionID || strings.TrimSpace(status.TransferState) == "" {
		return MojaloopTransferStatus{}, errors.New("mojaloop status response is not bound to the requested instruction")
	}
	return status, nil
}

func (c *FSPIOPMojaloopClient) SubmitTransfer(ctx context.Context, instruction MojaloopInstruction) (string, error) {
	if err := ValidateInstruction(instruction); err != nil {
		return "", err
	}
	if instruction.PayerFSP != c.sourceFSP {
		return "", errors.New("mojaloop instruction payer does not match configured source FSP")
	}
	payload := fspiopTransferRequest{
		TransferID: instruction.InstructionID,
		PayerFSP:   instruction.PayerFSP,
		PayeeFSP:   instruction.PayeeFSP,
		Expiration: instruction.Expiration.UTC().Format(time.RFC3339Nano),
		ILPPacket:  instruction.ILPPacket,
		Condition:  instruction.Condition,
	}
	payload.Amount.Currency = instruction.Currency
	payload.Amount.Amount = instruction.Amount
	body, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode Mojaloop transfer request: %w", err)
	}
	const requestURI = "/transfers"
	signature, err := c.signer.SignFSPIOP(ctx, http.MethodPost, requestURI, body)
	if err != nil || strings.TrimSpace(signature) == "" {
		return "", errors.New("mojaloop FSPIOP request signature is unavailable")
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: requestURI})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create Mojaloop request: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.interoperability.transfers+json;version=1.1")
	request.Header.Set("Content-Type", "application/vnd.interoperability.transfers+json;version=1.1")
	request.Header.Set("Date", time.Now().UTC().Format(http.TimeFormat))
	request.Header.Set("FSPIOP-Source", c.sourceFSP)
	request.Header.Set("FSPIOP-Destination", instruction.PayeeFSP)
	request.Header.Set("FSPIOP-URI", requestURI)
	request.Header.Set("FSPIOP-HTTP-Method", http.MethodPost)
	request.Header.Set("FSPIOP-Signature", signature)

	response, err := c.http.Do(request)
	if err != nil {
		return "", errors.New("mojaloop endpoint is unavailable")
	}
	defer response.Body.Close()
	// FSPIOP POST is asynchronous. The only successful immediate response is
	// 202 Accepted; a later callback determines the transfer's outcome.
	if response.StatusCode != http.StatusAccepted {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return "", fmt.Errorf("mojaloop transfer request was not accepted: HTTP %d", response.StatusCode)
	}
	return instruction.InstructionID, nil
}

func decodeBase64Octets(value string) ([]byte, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, errors.New("empty encoded value")
	}
	for _, encoding := range []*base64.Encoding{base64.RawURLEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.StdEncoding} {
		if decoded, err := encoding.DecodeString(value); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("value is not valid base64")
}

func validateILPCryptographicFields(packet, condition string) error {
	packetBytes, err := decodeBase64Octets(packet)
	if err != nil || len(packetBytes) < 1 {
		return errors.New("ILP packet must be nonempty base64-encoded octets")
	}
	// ILPv4 Prepare packets have version 4 in the high nibble and packet type
	// 12 (Prepare) in the low nibble. A different packet type cannot authorize a
	// transfer submission through this adapter.
	if packetBytes[0]>>4 != 4 || packetBytes[0]&0x0f != 12 {
		return errors.New("ILP packet must be an ILPv4 Prepare packet")
	}
	conditionBytes, err := decodeBase64Octets(condition)
	if err != nil || len(conditionBytes) != 32 {
		return errors.New("ILP execution condition must decode to exactly 32 bytes")
	}
	return nil
}

func normalizeMojaloopTransferState(status MojaloopTransferStatus) (multirail.Submission, error) {
	state := strings.ToUpper(strings.TrimSpace(status.TransferState))
	switch state {
	case "COMMITTED":
		return multirail.Submission{ProviderRef: status.TransferID, Status: multirail.Settled, Reason: "Mojaloop reports committed transfer"}, nil
	case "RESERVED", "PREPARED", "RECEIVED", "PROCESSING":
		return multirail.Submission{ProviderRef: status.TransferID, Status: multirail.Pending, Reason: "Mojaloop reports an in-progress transfer"}, nil
	case "ABORTED":
		return multirail.Submission{ProviderRef: status.TransferID, Status: multirail.Failed, RetryableWithoutBusinessEffect: true, Reason: "Mojaloop reports an aborted transfer"}, nil
	default:
		return multirail.Submission{ProviderRef: status.TransferID, Status: multirail.Unknown, Reason: "Mojaloop returned an unrecognized transfer state"}, multirail.ErrUnknownOutcome
	}
}
