package main

import "testing"

func TestEnvBool(t *testing.T) {
	const key = "MAILARCHIVE_TEST_BOOL"
	for _, tc := range []struct {
		value string
		want  bool
	}{
		{"", false},
		{"true", true},
		{"1", true},
		{"false", false},
		{"0", false},
		{"yes", false},
		{"TRUE", true},
	} {
		t.Setenv(key, tc.value)
		if got := envBool(key); got != tc.want {
			t.Errorf("envBool(%q) = %v, want %v", tc.value, got, tc.want)
		}
	}
}

func TestParsePrefixes(t *testing.T) {
	got, err := parsePrefixes(" 10.0.0.1, 192.168.0.0/16 ,fd00::1,,")
	if err != nil {
		t.Fatalf("parsePrefixes: %v", err)
	}
	want := []string{"10.0.0.1/32", "192.168.0.0/16", "fd00::1/128"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i].String() != want[i] {
			t.Errorf("prefix %d = %s, want %s", i, got[i], want[i])
		}
	}
	if got, err := parsePrefixes(""); err != nil || len(got) != 0 {
		t.Errorf("parsePrefixes(\"\") = %v, %v; want none", got, err)
	}
	for _, bad := range []string{"proxy", "10.0.0.0/33", "10.0.0"} {
		if _, err := parsePrefixes(bad); err == nil {
			t.Errorf("parsePrefixes(%q) accepted", bad)
		}
	}
}
