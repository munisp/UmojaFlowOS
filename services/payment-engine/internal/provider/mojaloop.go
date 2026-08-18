package provider

import (
	"context"
	"errors"
	"strings"
)

type MojaloopInstruction struct {
	InstructionID string
	Corridor      string
	Amount        string
	Currency      string
}

type MojaloopClient interface {
	SubmitTransfer(context.Context, MojaloopInstruction) (string, error)
}

type DisabledMojaloopClient struct{}

func (DisabledMojaloopClient) SubmitTransfer(context.Context, MojaloopInstruction) (string, error) {
	return "", errors.New("mojaloop provider is not configured and transfer submission is disabled")
}

func ValidateInstruction(instruction MojaloopInstruction) error {
	if strings.TrimSpace(instruction.InstructionID) == "" || strings.TrimSpace(instruction.Corridor) == "" || strings.TrimSpace(instruction.Amount) == "" || strings.TrimSpace(instruction.Currency) == "" {
		return errors.New("mojaloop instruction id, corridor, amount, and currency are required")
	}
	return nil
}
