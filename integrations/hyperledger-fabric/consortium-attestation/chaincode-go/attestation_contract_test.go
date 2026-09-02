package main

import "testing"

func TestDeterministicIDStableAndInputBound(t *testing.T) {
	id1 := deterministicID("0123456789abcdef0123456789abcdef01234567", "E-09", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	id2 := deterministicID("0123456789abcdef0123456789abcdef01234567", "E-09", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if id1 != id2 || len(id1) != 64 {
		t.Fatalf("unstable or malformed id: %s %s", id1, id2)
	}
	if id1 == deterministicID("0123456789abcdef0123456789abcdef01234567", "E-08", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("evidence ID not bound")
	}
	if id1 == deterministicID("1123456789abcdef0123456789abcdef01234567", "E-09", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("release SHA not bound")
	}
}

func TestDigestAndReleasePatterns(t *testing.T) {
	if !releaseSHApattern.MatchString("0123456789abcdef0123456789abcdef01234567") {
		t.Fatal("valid release SHA rejected")
	}
	if !sha256Pattern.MatchString("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("valid digest rejected")
	}
	for _, value := range []string{"", "ABC", "0123456789abcdef0123456789abcdef0123456Z"} {
		if releaseSHApattern.MatchString(value) {
			t.Fatalf("invalid release accepted: %q", value)
		}
	}
}
