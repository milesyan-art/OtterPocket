import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReturnUrl, formatTimestamp, parseSeekFragment, siteName } from './index.ts';

test('YouTube frames return to the exact second', () => {
  assert.equal(
    buildReturnUrl({ pageUrl: 'https://www.youtube.com/watch?v=abc123&t=5s', videoTime: 83.7 }),
    'https://www.youtube.com/watch?v=abc123&t=83s',
  );
  assert.equal(buildReturnUrl({ pageUrl: 'https://youtu.be/abc123', videoTime: 12 }), 'https://youtu.be/abc123?t=12s');
});

test('Vimeo uses its own #t= fragment', () => {
  assert.equal(buildReturnUrl({ pageUrl: 'https://vimeo.com/76979871', videoTime: 61.2 }), 'https://vimeo.com/76979871#t=61s');
});

test('other video pages get our seek fragment, unless they already use the hash', () => {
  assert.equal(
    buildReturnUrl({ pageUrl: 'https://example.com/news/launch', videoTime: 83.4 }),
    'https://example.com/news/launch#otterpocket-t=83.40',
  );
  assert.equal(
    buildReturnUrl({ pageUrl: 'https://app.example.com/#/watch/1', videoTime: 83.4 }),
    'https://app.example.com/#/watch/1',
  );
});

test('images return to the nearby text with a text fragment', () => {
  assert.equal(
    buildReturnUrl({ pageUrl: 'https://www.newyorker.com/magazine/a', textQuote: 'Illustration by Jane Doe-Smith, 2024' }),
    'https://www.newyorker.com/magazine/a#:~:text=Illustration%20by%20Jane%20Doe%2DSmith%2C%202024',
  );
  assert.equal(
    buildReturnUrl({ pageUrl: 'https://example.com/a#section', textQuote: 'hello' }),
    'https://example.com/a#section:~:text=hello',
  );
});

test('plain pages and invalid URLs pass through', () => {
  assert.equal(buildReturnUrl({ pageUrl: 'https://example.com/history' }), 'https://example.com/history');
  assert.equal(buildReturnUrl({ pageUrl: 'not a url' }), 'not a url');
});

test('parseSeekFragment reads only our key', () => {
  assert.equal(parseSeekFragment('#otterpocket-t=83.40'), 83.4);
  assert.equal(parseSeekFragment('#foo=1&otterpocket-t=12'), 12);
  assert.equal(parseSeekFragment('#t=12'), null);
  assert.equal(parseSeekFragment(''), null);
});

test('formatTimestamp and siteName', () => {
  assert.equal(formatTimestamp(83.4), '1:23');
  assert.equal(formatTimestamp(3723), '1:02:03');
  assert.equal(siteName('https://www.newyorker.com/x'), 'newyorker.com');
});
