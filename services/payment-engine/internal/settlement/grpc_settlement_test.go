package settlement

import (
	"context"
	"errors"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
)

func TestGRPCSettlementRoundTrip(t *testing.T) {
	const size = 1 << 20
	lis := bufconn.Listen(size)
	server := grpc.NewServer()
	RegisterGRPCSettlementServer(server, &GRPCSettlementServer{Handler: func(ctx context.Context, in Intent) (ProviderResult, error) {
		if in.TenantID != "tenant-a" {
			t.Errorf("tenant=%q", in.TenantID)
		}
		if string(in.Payload) != "payload" {
			t.Errorf("payload=%q", in.Payload)
		}
		return ProviderResult{State: Settled, Reference: "grpc-1", Reason: "ok"}, nil
	}})
	go server.Serve(lis)
	defer server.Stop()
	conn, err := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return lis.Dial() }), grpc.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	out, err := NewGRPCSettlementClient(conn).Execute(context.Background(), Intent{ID: "i", IdempotencyKey: "k", TenantID: "tenant-a", Asset: "USDC", Fiat: "NGN", Direction: Onramp, AmountMinor: 1, Payload: []byte("payload")})
	if err != nil || out.State != Settled || out.Reference != "grpc-1" {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestGRPCSettlementRejectsInvalidAndMapsServerFailure(t *testing.T) {
	const size = 1 << 20
	lis := bufconn.Listen(size)
	server := grpc.NewServer()
	RegisterGRPCSettlementServer(server, &GRPCSettlementServer{Handler: func(context.Context, Intent) (ProviderResult, error) {
		return ProviderResult{}, errors.New("upstream unavailable")
	}})
	go server.Serve(lis)
	defer server.Stop()
	conn, err := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return lis.Dial() }), grpc.WithInsecure())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client := NewGRPCSettlementClient(conn)
	out, err := client.Execute(context.Background(), Intent{ID: "", IdempotencyKey: "k", TenantID: "t", Asset: "USDC", Fiat: "NGN", Direction: Onramp, AmountMinor: 1, Payload: []byte("x")})
	if err == nil || out.State != Held {
		t.Fatalf("invalid out=%+v err=%v", out, err)
	}
	out, err = client.Execute(context.Background(), validIntent())
	if err == nil || out.State != Unknown {
		t.Fatalf("failure out=%+v err=%v", out, err)
	}
}
