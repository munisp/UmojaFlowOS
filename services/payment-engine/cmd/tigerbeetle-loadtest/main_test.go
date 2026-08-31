package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRequiredUnsignedParsers(t *testing.T) {
	t.Setenv("TEST_U32", "7")
	if got, err := requiredUint32("TEST_U32"); err != nil || got != 7 { t.Fatalf("uint32 got=%d err=%v", got, err) }
	t.Setenv("TEST_U16", "9")
	if got, err := requiredUint16("TEST_U16"); err != nil || got != 9 { t.Fatalf("uint16 got=%d err=%v", got, err) }
	t.Setenv("TEST_U64", "11")
	if got, err := requiredUint64("TEST_U64"); err != nil || got != 11 { t.Fatalf("uint64 got=%d err=%v", got, err) }
}

func TestRequiredClusterIDAcceptsDecimalAndHex(t *testing.T) {
	t.Setenv("CLUSTER", "42")
	decimal, err := requiredClusterID("CLUSTER")
	decimalLo, decimalHi := decimal.Uint64()
	if err != nil || decimalLo != 42 || decimalHi != 0 { t.Fatalf("decimal=%v err=%v", decimal, err) }
	t.Setenv("CLUSTER", "0x2a")
	hex, err := requiredClusterID("CLUSTER")
	hexLo, hexHi := hex.Uint64()
	if err != nil || hexLo != 42 || hexHi != 0 { t.Fatalf("hex=%v err=%v", hex, err) }
}

func TestPercentileAndSortFloats(t *testing.T) {
	values := []float64{9, 1, 5, 3}
	sortFloats(values)
	if values[0] != 1 || values[3] != 9 || percentile(values, .5) != 3 { t.Fatalf("values=%v median=%v", values, percentile(values, .5)) }
}

func TestWriteMetrics(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metrics.json")
	if err := writeMetrics(path, report{Status: "passed", Transfers: 10, Batches: 2}); err != nil { t.Fatal(err) }
	contents, err := os.ReadFile(path)
	if err != nil { t.Fatal(err) }
	if len(contents) == 0 { t.Fatal("metrics file is empty") }
}
