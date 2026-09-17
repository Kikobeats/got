import * as test from 'ava';

export default function invalidUrl(t: test.ExecutionContext, error: (TypeError & NodeJS.ErrnoException) | undefined, url: string): void {
	t.is(error?.code, 'ERR_INVALID_URL');

	if (error?.message === 'Invalid URL') {
		t.is((error as any).input, url);
	} else {
		t.is(error?.message.slice('Invalid URL: '.length), url);
	}
}
