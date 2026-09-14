import test from 'ava';
import got, {HTTPError} from '../source';
import withServer from './helpers/with-server';
import invalidUrl from './helpers/invalid-url';

test('works', withServer, async (t, server) => {
	server.get('/', (_request, response) => {
		response.end('ok');
	});

	server.get('/404', (_request, response) => {
		response.statusCode = 404;
		response.end('not found');
	});

	t.is((await got.get(server.url)).body, 'ok');

	const error = await t.throwsAsync<HTTPError>(got.get(`${server.url}/404`), {instanceOf: HTTPError});
	t.is(error.response.body, 'not found');

	const invalidUrlError = await t.throwsAsync<TypeError & NodeJS.ErrnoException>(got.get('.com', {retry: 0}));
	invalidUrl(t, invalidUrlError, '.com');
});
