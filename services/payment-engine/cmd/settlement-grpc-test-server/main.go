package main

import (
	"context"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/settlement"
	"google.golang.org/grpc"
)

func main() {
	addr := flag.String("addr", ":18443", "listen address")
	flag.Parse()
	lis, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	server := grpc.NewServer()
	settlement.RegisterGRPCSettlementServer(server, &settlement.GRPCSettlementServer{
		Handler: func(context.Context, settlement.Intent) (settlement.ProviderResult, error) {
			return settlement.ProviderResult{State: settlement.Settled, Reference: "ci-reference"}, nil
		},
		QueryHandler: func(context.Context, settlement.Intent) (settlement.ProviderResult, error) {
			return settlement.ProviderResult{State: settlement.Settled, Reference: "ci-reference"}, nil
		},
	})
	go func() {
		if err := server.Serve(lis); err != nil {
			log.Printf("serve: %v", err)
		}
	}()
	log.Printf("settlement gRPC test server listening on %s", *addr)
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM)
	<-ch
	server.GracefulStop()
}
