package main

import (
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

func pong(dir string) error {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		return err
	}
	if _, err := unix.InotifyAddWatch(fd, dir, unix.IN_CLOSE_WRITE|unix.IN_MOVED_TO); err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), "inotify")
	buf := make([]byte, 64<<10)
	for {
		n, err := f.Read(buf)
		if err != nil {
			return err
		}
		for off := 0; off+unix.SizeofInotifyEvent <= n; {
			ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[off]))
			name := strings.TrimRight(string(buf[off+unix.SizeofInotifyEvent:off+unix.SizeofInotifyEvent+int(ev.Len)]), "\x00")
			off += unix.SizeofInotifyEvent + int(ev.Len)
			if strings.HasPrefix(name, "ping-") {
				answer(dir, name)
			}
		}
	}
}
