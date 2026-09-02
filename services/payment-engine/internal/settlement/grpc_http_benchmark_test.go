package settlement

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/test/bufconn"
)

func BenchmarkSettlementTransport(b *testing.B) {
	in := validIntent()
	b.Run("grpc_bufconn", func(b *testing.B) {
		lis := bufconn.Listen(1 << 20)
		srv := grpc.NewServer()
		RegisterGRPCSettlementServer(srv, &GRPCSettlementServer{Handler: func(context.Context, Intent) (ProviderResult, error) {
			return ProviderResult{State: Settled, Reference: "bench"}, nil
		}})
		go srv.Serve(lis)
		defer srv.Stop()
		conn, err := grpc.DialContext(context.Background(), "bufnet", grpc.WithContextDialer(func(context.Context, string) (net.Conn, error) { return lis.Dial() }), grpc.WithInsecure())
		if err != nil {
			b.Fatal(err)
		}
		defer conn.Close()
		client := NewGRPCSettlementClient(conn)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := client.Execute(context.Background(), in); err != nil {
				b.Fatal(err)
			}
		}
	})
	b.Run("http_json", func(b *testing.B) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"reference":"bench","state":"settled"}`))
		}))
		defer srv.Close()
		provider, err := NewHTTPFiatRail(HTTPProviderConfig{BaseURL: srv.URL, Client: srv.Client()})
		if err != nil {
			b.Fatal(err)
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := provider.Collect(context.Background(), in); err != nil {
				b.Fatal(err)
			}
		}
	})
}
