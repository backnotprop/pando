//go:build !linux

package main

import "errors"

func pong(dir string) error { return errors.New("pong runs on Linux (inotify)") }
