package main

import (
	"context"
	"crypto/ed25519"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func fenceIntEnv(getenv func(string) string, key string, fallback int) (int, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
}

func openProductionFenceDB(ctx context.Context, production bool) (*sql.DB, error) {
	dsn := strings.TrimSpace(os.Getenv("UMOJA_FENCE_DATABASE_URL"))
	if dsn == "" {
		if production {
			return nil, errors.New("UMOJA_FENCE_DATABASE_URL is required when production settlement is enabled")
		}
		return nil, nil
	}

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open durable settlement fence database: %w", err)
	}
	maxOpen, err := fenceIntEnv(os.Getenv, "UMOJA_FENCE_DB_MAX_OPEN_CONNS", 16)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	maxIdle, err := fenceIntEnv(os.Getenv, "UMOJA_FENCE_DB_MAX_IDLE_CONNS", 8)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if maxIdle > maxOpen {
		_ = db.Close()
		return nil, errors.New("UMOJA_FENCE_DB_MAX_IDLE_CONNS cannot exceed UMOJA_FENCE_DB_MAX_OPEN_CONNS")
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxIdle)
	if raw := strings.TrimSpace(os.Getenv("UMOJA_FENCE_DB_CONN_MAX_LIFETIME")); raw != "" {
		lifetime, parseErr := time.ParseDuration(raw)
		if parseErr != nil || lifetime <= 0 {
			_ = db.Close()
			return nil, errors.New("UMOJA_FENCE_DB_CONN_MAX_LIFETIME must be a positive duration")
		}
		db.SetConnMaxLifetime(lifetime)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("durable settlement fence database readiness: %w", err)
	}
	return db, nil
}

func loadFencePublicKey(getenv func(string) string) (ed25519.PublicKey, error) {
	raw := strings.TrimSpace(getenv("UMOJA_FENCE_PUBLIC_KEY_B64"))
	if raw == "" {
		return nil, errors.New("UMOJA_FENCE_PUBLIC_KEY_B64 is required when durable settlement fencing is enabled")
	}
	decoded, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("decode UMOJA_FENCE_PUBLIC_KEY_B64: %w", err)
	}
	if len(decoded) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("UMOJA_FENCE_PUBLIC_KEY_B64 must decode to %d bytes", ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(decoded), nil
}
