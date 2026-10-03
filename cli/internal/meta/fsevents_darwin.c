//go:build darwin && cgo

// FSEvents for the meta layer watcher (watch_darwin.go). The stream runs on
// its own serial dispatch queue and hands each batch of paths to Go.

#include <CoreServices/CoreServices.h>
#include <dispatch/dispatch.h>
#include <stdint.h>
#include <stdlib.h>
#include "_cgo_export.h"

struct pando_fsevents {
	FSEventStreamRef stream;
	dispatch_queue_t queue;
};

static void pando_fsevents_cb(ConstFSEventStreamRef s, void *info, size_t n, void *paths,
                              const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
	pandoFSEvents((uintptr_t)info, n, (char **)paths, (uint32_t *)flags);
}

static CFStringRef pando_cfstr(const char *s) {
	return CFStringCreateWithCString(NULL, s, kCFStringEncodingUTF8);
}

struct pando_fsevents *pando_fsevents_start(uintptr_t handle, const char *root, const char **excl, int nexcl, double latency) {
	CFStringRef r = pando_cfstr(root);
	CFArrayRef paths = CFArrayCreate(NULL, (const void **)&r, 1, &kCFTypeArrayCallBacks);
	FSEventStreamContext ctx = {0, (void *)handle, NULL, NULL, NULL};
	FSEventStreamRef s = FSEventStreamCreate(NULL, pando_fsevents_cb, &ctx, paths, kFSEventStreamEventIdSinceNow, latency,
		kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagWatchRoot);
	CFRelease(paths);
	CFRelease(r);
	if (s == NULL) return NULL;
	if (nexcl > 0) {
		CFStringRef ex[8];
		int k = nexcl > 8 ? 8 : nexcl; // FSEvents takes at most 8
		for (int i = 0; i < k; i++) ex[i] = pando_cfstr(excl[i]);
		CFArrayRef arr = CFArrayCreate(NULL, (const void **)ex, k, &kCFTypeArrayCallBacks);
		FSEventStreamSetExclusionPaths(s, arr);
		CFRelease(arr);
		for (int i = 0; i < k; i++) CFRelease(ex[i]);
	}
	dispatch_queue_t q = dispatch_queue_create("ai.plannotator.pando.meta.fsevents", DISPATCH_QUEUE_SERIAL);
	FSEventStreamSetDispatchQueue(s, q);
	if (!FSEventStreamStart(s)) {
		FSEventStreamInvalidate(s);
		FSEventStreamRelease(s);
		dispatch_release(q);
		return NULL;
	}
	struct pando_fsevents *w = malloc(sizeof *w);
	w->stream = s;
	w->queue = q;
	return w;
}

static void pando_noop(void *ctx) {}

void pando_fsevents_stop(struct pando_fsevents *w) {
	FSEventStreamStop(w->stream);
	FSEventStreamInvalidate(w->stream);
	dispatch_sync_f(w->queue, NULL, pando_noop); // no callback is still running after this
	FSEventStreamRelease(w->stream);
	dispatch_release(w->queue);
	free(w);
}
