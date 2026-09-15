import {PassThrough} from 'stream';
import test from 'ava';
import trackCloneCompletion from '../source/core/utils/track-clone-completion';

type Clone = PassThrough & {complete: boolean};

const createSnapshotClone = (): Clone => {
	const clone = new PassThrough() as Clone;
	clone.complete = false;
	return clone;
};

const createLiveClone = (source: {complete: boolean}): Clone => {
	const clone = new PassThrough() as Clone;
	Object.defineProperty(clone, 'complete', {
		get: () => source.complete,
		enumerable: true,
		configurable: false
	});
	return clone;
};

test('`complete` of a snapshot clone follows the piped body', t => {
	const clone = createSnapshotClone();

	trackCloneCompletion(clone);
	t.false(clone.complete);

	clone.end('body');
	t.true(clone.complete);
});

test('a clone with a non-configurable `complete` getter is left untouched', t => {
	const source = {complete: false};
	const clone = createLiveClone(source);

	t.notThrows(() => {
		trackCloneCompletion(clone);
	});

	t.false(clone.complete);
	source.complete = true;
	t.true(clone.complete);
});

test('responses that are not clones are left untouched', t => {
	const response = {complete: false};

	trackCloneCompletion(response);

	t.deepEqual(Object.getOwnPropertyDescriptor(response, 'complete'), {
		value: false,
		writable: true,
		enumerable: true,
		configurable: true
	});
});
