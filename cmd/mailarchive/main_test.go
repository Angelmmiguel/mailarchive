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
