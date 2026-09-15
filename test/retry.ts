import {EventEmitter} from 'events';
import {PassThrough as PassThroughStream, Duplex} from 'stream';
import net = require('net');
import {Socket, createServer} from 'net';
import http = require('http');
import test, {ExecutionContext} from 'ava';
import is from '@sindresorhus/is';
import {Handler} from 'express';
import getStream = require('get-stream');
import pEvent = require('p-event');
import got, {HTTPError, RequestError} from '../source';
import withServer from './helpers/with-server';

const retryAfterOn413 = 2;
const socketTimeout = 300;

const handler413: Handler = (_request, response) => {
	response.writeHead(413, {
		'Retry-After': retryAfterOn413
	});
	response.end();
};

type RequestEndErrorScenario = 'request-error-first' | 'end-callback-only';

const createRequestWithEndError = (scenario: RequestEndErrorScenario): http.ClientRequest => {
	const request = new EventEmitter() as http.ClientRequest;

	// @ts-expect-error Mocking the behaviour of a ClientRequest
	request.end = (callback: (error: Error) => void) => {
		const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), {code: 'ECONNREFUSED'});

		process.nextTick(() => {
			if (scenario === 'request-error-first') {
				request.emit('error', connectionError);
			}

			callback(connectionError);
		});
	};

	request.abort = () => {};

	request.destroy = () => {
		request.destroyed = true;
		return request;
	};

	return request;
};

const createDestroyedRequest = ({emitsError, emitsClose = true}: {emitsError: boolean; emitsClose?: boolean}): http.ClientRequest => {
	const request = new EventEmitter() as http.ClientRequest;

	// @ts-expect-error Mocking the behaviour of a ClientRequest
	request.write = (_chunk: unknown, _encoding: unknown, callback?: () => void) => {
		process.nextTick(() => callback?.());
		return true;
	};

	// @ts-expect-error Mocking the behaviour of a ClientRequest
	request.end = (callback: (error: Error) => void) => {
		process.nextTick(() => {
			callback(Object.assign(new Error('write ECANCELED'), {code: 'ECANCELED'}));

			if (emitsError) {
				request.emit('error', Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'}));
			}

			if (emitsClose) {
				request.emit('close');
			}
		});
	};

	request.abort = () => {};

	request.destroy = () => {
		request.destroyed = true;
		return request;
	};

	return request;
};

const retryImmediately = {
	calculateDelay: ({computedValue}: {computedValue: number}) => computedValue === 0 ? 0 : 1
};

const getClosedPortUrl = async (): Promise<string> => {
	const server = createServer();
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	const {port} = server.address() as {port: number};
	await new Promise(resolve => {
		server.close(resolve);
	});

	return `http://127.0.0.1:${port}`;
};

const createSocketTimeoutStream = (): http.ClientRequest => {
	const stream = new PassThroughStream();
	// @ts-expect-error Mocking the behaviour of a ClientRequest
	stream.setTimeout = (ms, callback) => {
		process.nextTick(callback);
	};

	// @ts-expect-error Mocking the behaviour of a ClientRequest
	stream.abort = () => {};
	stream.resume();

	return stream as unknown as http.ClientRequest;
};

test('works on timeout', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		response.end('who`s there?');
	});

	t.is((await got({
		timeout: {
			socket: socketTimeout
		},
		request: (...args: [
			string | URL | http.RequestOptions,
			(http.RequestOptions | ((response: http.IncomingMessage) => void))?,
			((response: http.IncomingMessage) => void)?
		]) => {
			if (knocks === 1) {
				// @ts-expect-error Overload error
				return http.request(...args);
			}

			knocks++;
			return createSocketTimeoutStream();
		}
	})).body, 'who`s there?');
});

test('retry function gets iteration count', withServer, async (t, server, got) => {
	let knocks = 0;
	server.get('/', (_request, response) => {
		if (knocks++ === 1) {
			response.end('who`s there?');
			return;
		}

		response.statusCode = 500;
		response.end();
	});

	await got({
		retry: {
			calculateDelay: ({attemptCount}) => {
				t.true(is.number(attemptCount));
				return attemptCount < 2 ? 1 : 0;
			}
		}
	});
});

test('setting to `0` disables retrying', async t => {
	await t.throwsAsync(got('https://example.com', {
		timeout: {socket: socketTimeout},
		retry: {
			calculateDelay: ({attemptCount}) => {
				t.is(attemptCount, 1);
				return 0;
			}
		},
		request: () => {
			return createSocketTimeoutStream();
		}
	}), {
		instanceOf: got.TimeoutError,
		message: `Timeout awaiting 'socket' for ${socketTimeout}ms`
	});
});

test('custom retries', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await t.throwsAsync<HTTPError>(got({
		throwHttpErrors: true,
		retry: {
			calculateDelay: ({attemptCount}) => {
				if (attemptCount === 1) {
					hasTried = true;
					return 1;
				}

				return 0;
			},
			methods: [
				'GET'
			],
			statusCodes: [
				500
			]
		}
	}));
	t.is(error.response.statusCode, 500);
	t.true(hasTried);
});

test('custom retries async', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let hasTried = false;
	const error = await t.throwsAsync<HTTPError>(got({
		throwHttpErrors: true,
		retry: {
			calculateDelay: async ({attemptCount}) => {
				await new Promise(resolve => {
					setTimeout(resolve, 1000);
				});

				if (attemptCount === 1) {
					hasTried = true;
					return 1;
				}

				return 0;
			},
			methods: [
				'GET'
			],
			statusCodes: [
				500
			]
		}
	}));
	t.is(error.response.statusCode, 500);
	t.true(hasTried);
});

test('custom error codes', async t => {
	const errorCode = 'OH_SNAP';

	const error = await t.throwsAsync<Error & {code: typeof errorCode}>(got('https://example.com', {
		request: () => {
			const emitter = new EventEmitter() as http.ClientRequest;
			emitter.abort = () => {};

			// @ts-expect-error
			emitter.end = () => {};

			// @ts-expect-error
			emitter.destroy = () => {};

			const error = new Error('Snap!');
			(error as Error & {code: typeof errorCode}).code = errorCode;
			setTimeout(() => {
				emitter.emit('error', error);
			});

			return emitter;
		},
		retry: {
			calculateDelay: ({error}) => {
				t.is(error.code, errorCode);
				return 0;
			},
			methods: [
				'GET'
			],
			errorCodes: [
				errorCode
			]
		}
	}));

	t.is(error.code, errorCode);
});

test('retries when ClientRequest emits a connection error before its end callback receives it', async t => {
	let attemptCount = 0;
	let beforeRetryCount = 0;
	let beforeErrorCount = 0;

	const error = await t.throwsAsync<RequestError>(got('http://localhost', {
		request: () => {
			attemptCount++;
			return createRequestWithEndError('request-error-first');
		},
		retry: {
			limit: 2,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				(_options, error) => {
					beforeRetryCount++;
					t.is(error?.code, 'ECONNREFUSED');
				}
			],
			beforeError: [
				error => {
					beforeErrorCount++;
					return error;
				}
			]
		}
	}), {
		instanceOf: RequestError
	});

	t.is(attemptCount, 3);
	t.is(beforeRetryCount, 2);
	t.is(beforeErrorCount, 1);
	t.is(error.code, 'ECONNREFUSED');
	t.is(error.request?.retryCount, 2);
});

test('retries when only the end callback receives the connection error', async t => {
	let attemptCount = 0;

	const error = await t.throwsAsync<RequestError>(got('http://localhost', {
		request: () => {
			attemptCount++;
			return createRequestWithEndError('end-callback-only');
		},
		retry: {
			limit: 1,
			...retryImmediately
		}
	}), {
		instanceOf: RequestError
	});

	t.is(attemptCount, 2);
	t.is(error.code, 'ECONNREFUSED');
	t.is(error.request?.retryCount, 1);
});

test('recovers when retrying after a request end error', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	let attemptCount = 0;
	const response = await got({
		request: (url, options) => {
			attemptCount++;

			if (attemptCount === 1) {
				return createRequestWithEndError('end-callback-only');
			}

			return http.request(url, options);
		},
		retry: {
			limit: 1,
			...retryImmediately
		}
	});

	t.is(response.body, 'ok');
	t.is(response.retryCount, 1);
	t.is(attemptCount, 2);
});

test('end callback errors do not finish the stream before retrying', async t => {
	const stream = got.stream('http://localhost', {
		request: () => createRequestWithEndError('end-callback-only'),
		retry: {
			limit: 1,
			...retryImmediately
		}
	});

	let finishCount = 0;
	stream.on('finish', () => {
		finishCount++;
	});

	await pEvent(stream, 'retry');

	t.is(finishCount, 0);
	t.false(stream.writableFinished);
	stream.destroy();
});

test('retries a refused connection and rejects with the connection error', async t => {
	const url = await getClosedPortUrl();
	let beforeRetryCount = 0;

	const error = await t.throwsAsync<RequestError>(got(url, {
		retry: {
			limit: 2,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				() => {
					beforeRetryCount++;
				}
			]
		}
	}), {
		instanceOf: RequestError
	});

	t.is(error.code, 'ECONNREFUSED');
	t.is(beforeRetryCount, 2);
	t.is(error.request?.retryCount, 2);
});

test('retries the request error that follows an `ECANCELED` end callback', async t => {
	let attemptCount = 0;
	const retries: Array<string | undefined> = [];

	const error = await t.throwsAsync<RequestError>(got.put('http://localhost', {
		body: 'wow',
		request: () => {
			attemptCount++;
			return createDestroyedRequest({emitsError: true});
		},
		retry: {
			limit: 2,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				(_options, error) => {
					retries.push(error?.code);
				}
			]
		}
	}), {
		instanceOf: RequestError
	});

	t.is(error.code, 'ECONNRESET');
	t.is(attemptCount, 3);
	t.deepEqual(retries, ['ECONNRESET', 'ECONNRESET']);
});

test('rejects with `ECANCELED` when the destroyed request emits no error', async t => {
	let attemptCount = 0;

	const error = await t.throwsAsync<RequestError>(got.put('http://localhost', {
		body: 'wow',
		request: () => {
			attemptCount++;
			return createDestroyedRequest({emitsError: false});
		},
		retry: {
			limit: 2,
			...retryImmediately
		}
	}), {
		instanceOf: RequestError
	});

	t.is(error.code, 'ECANCELED');
	t.is(attemptCount, 1);
});

test('rejects with `ECANCELED` when the destroyed request emits neither error nor close', async t => {
	const error = await t.throwsAsync<RequestError>(got.put('http://localhost', {
		body: 'wow',
		request: () => createDestroyedRequest({emitsError: false, emitsClose: false}),
		retry: 0
	}), {
		instanceOf: RequestError
	});

	t.is(error.code, 'ECANCELED');
});

test('retries an upload whose socket is destroyed without an error', async t => {
	const server = http.createServer(request => {
		request.pause();
	});

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	t.teardown(() => {
		server.close();
	});

	const {port} = server.address() as {port: number};
	const retries: Array<string | undefined> = [];

	const error = await t.throwsAsync<RequestError>(got.put(`http://127.0.0.1:${port}`, {
		body: Buffer.alloc(64 * 1024 * 1024),
		agent: {http: new http.Agent({keepAlive: false})},
		request: (url, options, callback) => {
			const request = http.request(url, options, callback);
			request.once('socket', socket => {
				setTimeout(() => {
					socket.destroy();
				}, 100);
			});
			return request;
		},
		retry: {
			limit: 1,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				(_options, error) => {
					retries.push(error?.code);
				}
			]
		}
	}), {
		instanceOf: RequestError
	});

	t.is(error.code, 'ECONNRESET');
	t.deepEqual(retries, ['ECONNRESET']);
});

const listenOnLocalhost = async (t: ExecutionContext, handler: http.RequestListener): Promise<number> => {
	const server = http.createServer(handler);

	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	t.teardown(() => {
		server.close();
	});

	return (server.address() as net.AddressInfo).port;
};

const respondOk: http.RequestListener = (request, response) => {
	request.resume();
	request.on('end', () => {
		response.end('ok');
	});
};

const requestDestroyedOnConnect = async (port: number, options: {method: 'PUT' | 'GET'; body?: string}): Promise<{body: string; retries: Array<string | undefined>}> => {
	let attemptCount = 0;
	const retries: Array<string | undefined> = [];

	const {body} = await got(`http://127.0.0.1:${port}`, {
		...options,
		agent: {http: new http.Agent({keepAlive: false})},
		request: (url, requestOptions, callback) => {
			const request = http.request(url, requestOptions, callback);

			if (attemptCount++ === 0) {
				request.once('socket', socket => {
					socket.once('connect', () => {
						socket.destroy();
					});
				});
			}

			return request;
		},
		retry: {
			limit: 1,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				(_options, error) => {
					retries.push(error?.code);
				}
			]
		}
	});

	return {body, retries};
};

test('retries an upload whose socket is destroyed when it connects', async t => {
	const port = await listenOnLocalhost(t, respondOk);
	const {body, retries} = await requestDestroyedOnConnect(port, {method: 'PUT', body: 'wow'});

	t.is(body, 'ok');
	t.deepEqual(retries, ['ECONNRESET']);
});

test('retries a request without a body whose socket is destroyed when it connects', async t => {
	const port = await listenOnLocalhost(t, respondOk);
	const {body, retries} = await requestDestroyedOnConnect(port, {method: 'GET'});

	t.is(body, 'ok');
	t.deepEqual(retries, ['ECONNRESET']);
});

class DelayedCloseSocket extends Duplex {
	connecting = true;

	private readonly inner: net.Socket;

	constructor(port: number) {
		super();

		this.inner = net.connect(port, '127.0.0.1');
		this.inner.on('data', (chunk: Buffer) => {
			if (!this.push(chunk)) {
				this.inner.pause();
			}
		});
		this.inner.on('end', () => this.push(null));
		this.inner.on('error', (error: Error) => this.destroy(error));
		this.inner.once('connect', () => {
			this.connecting = false;
			this.emit('connect');
		});
	}

	_read(): void {
		this.inner.resume();
	}

	_write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.inner.write(chunk, encoding, callback);
	}

	_final(callback: () => void): void {
		this.inner.end(callback);
	}

	_destroy(error: Error | null, callback: (error: Error | null) => void): void {
		this.inner.destroy();
		setTimeout(() => {
			callback(error);
		}, 5);
	}

	setNoDelay(): void {}

	setKeepAlive(): void {}

	setTimeout(): this {
		return this;
	}

	ref(): void {}

	unref(): void {}
}

test('retries an upload whose socket closes asynchronously after being destroyed', async t => {
	let hits = 0;
	const port = await listenOnLocalhost(t, (request, response) => {
		if (hits++ === 0) {
			request.pause();
			return;
		}

		respondOk(request, response);
	});

	let sockets = 0;
	const retries: Array<string | undefined> = [];

	const {body} = await got.put(`http://127.0.0.1:${port}`, {
		body: Buffer.alloc(8 * 1024 * 1024),
		request: (url, options, callback) => http.request(url, {
			...options,
			agent: undefined,
			createConnection: () => {
				const socket = new DelayedCloseSocket(port);

				if (sockets++ === 0) {
					setTimeout(() => {
						socket.destroy();
					}, 100);
				}

				return socket as unknown as net.Socket;
			}
		}, callback),
		retry: {
			limit: 1,
			...retryImmediately
		},
		hooks: {
			beforeRetry: [
				(_options, error) => {
					retries.push(error?.code);
				}
			]
		}
	});

	t.is(body, 'ok');
	t.deepEqual(retries, ['ECONNRESET']);
});

test('respects 413 Retry-After', withServer, async (t, server, got) => {
	let lastTried413access = Date.now();
	server.get('/', (_request, response) => {
		response.writeHead(413, {
			'Retry-After': retryAfterOn413
		});
		response.end((Date.now() - lastTried413access).toString());

		lastTried413access = Date.now();
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Number(body) >= retryAfterOn413 * 1000);
});

test('respects 413 Retry-After with RFC-1123 timestamp', withServer, async (t, server, got) => {
	let lastTried413TimestampAccess: string;
	server.get('/', (_request, response) => {
		const date = (new Date(Date.now() + (retryAfterOn413 * 1000))).toUTCString();

		response.writeHead(413, {
			'Retry-After': date
		});
		response.end(lastTried413TimestampAccess);
		lastTried413TimestampAccess = date;
	});

	const {statusCode, body} = await got({
		throwHttpErrors: false,
		retry: 1
	});
	t.is(statusCode, 413);
	t.true(Date.now() >= Date.parse(body));
});

test('doesn\'t retry on 413 with empty statusCodes and methods', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [],
			methods: []
		}
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 with empty methods', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: {
			limit: 1,
			statusCodes: [413],
			methods: []
		}
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('doesn\'t retry on 413 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 413;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('retries on 503 without Retry-After header', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 503;
		response.end();
	});

	const {retryCount} = await got({
		throwHttpErrors: false,
		retry: 1
	});
	t.is(retryCount, 1);
});

test('doesn\'t retry on streams', withServer, async (t, server, got) => {
	server.get('/', () => {});

	// @ts-expect-error Error tests
	const stream = got.stream({
		timeout: 1,
		retry: {
			retries: () => {
				t.fail('Retries on streams');
			}
		}
	});
	await t.throwsAsync(pEvent(stream, 'response'));
});

test('doesn\'t retry if Retry-After header is greater than maxRetryAfter', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {retryCount} = await got({
		retry: {maxRetryAfter: 1000},
		throwHttpErrors: false
	});
	t.is(retryCount, 0);
});

test('doesn\'t retry when set to 0', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const {statusCode, retryCount} = await got({
		throwHttpErrors: false,
		retry: 0
	});
	t.is(statusCode, 413);
	t.is(retryCount, 0);
});

test('works when defaults.options.retry is a number', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const instance = got.extend({
		retry: 2
	});

	const {retryCount} = await instance({
		throwHttpErrors: false
	});
	t.is(retryCount, 2);
});

test('retry function can throw', withServer, async (t, server, got) => {
	server.get('/', handler413);

	const error = 'Simple error';
	await t.throwsAsync(got({
		retry: {
			calculateDelay: () => {
				throw new Error(error);
			}
		}
	}), {message: error});
});

test('does not retry on POST', withServer, async (t, server, got) => {
	server.post('/', () => {});

	await t.throwsAsync(got.post({
		timeout: 200,
		hooks: {
			beforeRetry: [
				() => {
					t.fail('Retries on POST requests');
				}
			]
		}
	}), {instanceOf: got.TimeoutError});
});

test('does not break on redirect', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end();
	});

	let tries = 0;
	server.get('/redirect', (_request, response) => {
		tries++;

		response.writeHead(302, {
			location: '/'
		});
		response.end();
	});

	await t.throwsAsync(got('redirect'), {message: 'Response code 500 (Internal Server Error)'});
	t.is(tries, 1);
});

test('does not destroy the socket on HTTP error', withServer, async (t, server, got) => {
	let returnServerError = true;

	server.get('/', (_request, response) => {
		if (returnServerError) {
			response.statusCode = 500;
			returnServerError = false;
		}

		response.end();
	});

	const sockets: Socket[] = [];

	const agent = new http.Agent({
		keepAlive: true
	});

	await got('', {
		agent: {
			http: agent
		}
	}).on('request', request => {
		sockets.push(request.socket!);
	});

	t.is(sockets.length, 2);
	t.is(sockets[0], sockets[1]);

	agent.destroy();
});

test('can retry a Got stream', withServer, async (t, server, got) => {
	let returnServerError = true;

	server.get('/', (_request, response) => {
		if (returnServerError) {
			response.statusCode = 500;
			response.end('not ok');

			returnServerError = false;
			return;
		}

		response.end('ok');
	});

	let globalRetryCount = 0;

	const responseStreamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		let writeStream: PassThroughStream;

		const fn = (retryCount = 0) => {
			const stream = got.stream('');
			stream.retryCount = retryCount;

			globalRetryCount = retryCount;

			if (writeStream) {
				writeStream.destroy();
			}

			writeStream = new PassThroughStream();

			stream.pipe(writeStream);

			stream.once('retry', fn);

			stream.once('error', reject);
			stream.once('end', () => {
				resolve(writeStream);
			});
		};

		fn();
	});

	const responseStream = await responseStreamPromise;
	const data = await getStream(responseStream);

	t.is(data, 'ok');
	t.is(globalRetryCount, 1);
});

test('throws when cannot retry a Got stream', withServer, async (t, server, got) => {
	server.get('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	let globalRetryCount = 0;

	const streamPromise = new Promise<PassThroughStream>((resolve, reject) => {
		const fn = (retryCount = 0) => {
			const stream = got.stream('');
			stream.retryCount = retryCount;

			globalRetryCount = retryCount;

			stream.resume();
			stream.once('retry', fn);

			stream.once('data', () => {
				stream.destroy(new Error('data event has been emitted'));
			});

			stream.once('error', reject);
			stream.once('end', resolve);
		};

		fn();
	});

	const error = await t.throwsAsync<HTTPError>(streamPromise, {
		instanceOf: HTTPError
	});

	t.is(error.response.statusCode, 500);
	t.is(error.response.body, 'not ok');
	t.is(globalRetryCount, 2);
});

test('promise does not retry when body is a stream', withServer, async (t, server, got) => {
	server.post('/', (_request, response) => {
		response.statusCode = 500;
		response.end('not ok');
	});

	const body = new PassThroughStream();
	body.end('hello');

	const response = await got.post({
		retry: {
			methods: ['POST']
		},
		body,
		throwHttpErrors: false
	});

	t.is(response.retryCount, 0);
});
