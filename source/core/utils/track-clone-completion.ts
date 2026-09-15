import {PassThrough} from 'stream';

// `clone-response@1` copies `complete` as a value before the body has been piped, so it stays `false` and `aborted` becomes `true` once a keep-alive request is released. `clone-response@2` already exposes a live, non-configurable getter.
export default (response: unknown): void => {
	if (!(response instanceof PassThrough)) {
		return;
	}

	const descriptor = Object.getOwnPropertyDescriptor(response, 'complete');

	if (!descriptor?.writable) {
		return;
	}

	Object.defineProperty(response, 'complete', {
		get: () => response.writableEnded
	});
};
