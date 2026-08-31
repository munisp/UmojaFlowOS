package provider

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

var ErrMojaloopStatusQueryUnavailable = errors.New("Mojaloop status query is not configured; provider outcome remains unknown")

// MojaloopRail adapts the signed FSPIOP client to the provider-neutral rail
// interface. Mojaloop's immediate response is asynchronous acceptance, not
// settlement. The adapter therefore always returns Pending after a successful
// FSPIOP submission.
type MojaloopRail struct {
	Client MojaloopClient
	Build  func(multirail.Intent) (MojaloopInstruction, error)
	NameID string
}

func NewMojaloopRail(client MojaloopClient, builder func(multirail.Intent) (MojaloopInstruction, error)) (*MojaloopRail, error) {
	if client == nil {
		return nil, errors.New("Mojaloop client is required")
	}
	if builder == nil {
		builder = MojaloopInstructionFromIntent
	}
	return &MojaloopRail{Client: client, Build: builder, NameID: "mojaloop"}, nil
}

func (r *MojaloopRail) Name() string {
	if r == nil || strings.TrimSpace(r.NameID) == "" {
		return "mojaloop"
	}
	return r.NameID
}

func (r *MojaloopRail) Submit(ctx context.Context, intent multirail.Intent) (multirail.Submission, error) {
	if r == nil || r.Client == nil || r.Build == nil {
		return multirail.Submission{}, errors.New("Mojaloop rail is not configured")
	}
	instruction, err := r.Build(intent)
	if err != nil {
		return multirail.Submission{}, err
	}
	if instruction.InstructionID != intent.IdempotencyKey {
		return multirail.Submission{}, errors.New("Mojaloop instruction ID must equal the multirail idempotency key")
	}
	acceptedID, err := r.Client.SubmitTransfer(ctx, instruction)
	if err != nil {
		return multirail.Submission{}, err
	}
	if strings.TrimSpace(acceptedID) == "" || acceptedID != instruction.InstructionID {
		return multirail.Submission{}, errors.New("Mojaloop accepted reference does not match the bound instruction")
	}
	return multirail.Submission{ProviderRef: acceptedID, Status: multirail.Pending, Reason: "Mojaloop accepted the signed FSPIOP transfer asynchronously"}, nil
}

func (r *MojaloopRail) Query(context.Context, multirail.Intent) (multirail.Submission, error) {
	// MojaloopClient intentionally has no query method yet. Returning UNKNOWN is
	// safer than inventing a status or treating an asynchronous FSPIOP request as
	// a confirmed non-submission.
	return multirail.Submission{Status: multirail.Unknown, Reason: ErrMojaloopStatusQueryUnavailable.Error()}, ErrMojaloopStatusQueryUnavailable
}

// MojaloopInstructionFromIntent parses a previously authorized, canonical
// instruction. It cannot derive ILP packet/condition or FSP identities from a
// generic payment order; those fields must be supplied by the authorized
// upstream quote/fulfilment process.
func MojaloopInstructionFromIntent(intent multirail.Intent) (MojaloopInstruction, error) {
	if len(intent.Payload) == 0 || intent.IdempotencyKey == "" {
		return MojaloopInstruction{}, errors.New("Mojaloop requires a bound authorized instruction payload")
	}
	var instruction MojaloopInstruction
	if err := json.Unmarshal(intent.Payload, &instruction); err != nil {
		return MojaloopInstruction{}, errors.New("Mojaloop instruction payload is not valid JSON")
	}
	if instruction.InstructionID == "" {
		// Accept the canonical lower-camel wire form as well as the Go field form.
		var wire struct {
			InstructionID string `json:"instructionId"`
			Corridor      string `json:"corridor"`
			Amount        string `json:"amount"`
			Currency      string `json:"currency"`
			PayerFSP      string `json:"payerFsp"`
			PayeeFSP      string `json:"payeeFsp"`
			Expiration    string `json:"expiration"`
			ILPPacket     string `json:"ilpPacket"`
			Condition     string `json:"condition"`
		}
		if err := json.Unmarshal(intent.Payload, &wire); err != nil || wire.InstructionID == "" {
			return MojaloopInstruction{}, errors.New("Mojaloop payload lacks instructionId")
		}
		instruction.InstructionID, instruction.Corridor, instruction.Amount = wire.InstructionID, wire.Corridor, wire.Amount
		instruction.Currency, instruction.PayerFSP, instruction.PayeeFSP = wire.Currency, wire.PayerFSP, wire.PayeeFSP
		instruction.ILPPacket, instruction.Condition = wire.ILPPacket, wire.Condition
		if wire.Expiration != "" {
			var err error
			instruction.Expiration, err = parseMojaloopExpiration(wire.Expiration)
			if err != nil {
				return MojaloopInstruction{}, err
			}
		}
	}
	if instruction.InstructionID != intent.IdempotencyKey {
		return MojaloopInstruction{}, errors.New("Mojaloop instruction ID does not match intent idempotency key")
	}
	if err := ValidateInstruction(instruction); err != nil {
		return MojaloopInstruction{}, err
	}
	return instruction, nil
}

func parseMojaloopExpiration(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
	if err != nil {
		return time.Time{}, errors.New("Mojaloop expiration must be RFC3339")
	}
	return parsed, nil
}
