import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooserPage, codePage, donePage, failedPage } from './signInPages.js';

test('the sign-in page offers every way in, each carrying this run’s token', () => {
	const html = chooserPage({ token: 'tok123', google: true });
	assert.match(html, /Continue with Google/);
	assert.match(html, /Continue with GitHub/);
	assert.match(html, /Work email/);
	assert.match(html, /href="\/google\?t=tok123"/);
	assert.match(html, /href="\/github\?t=tok123"/);
	assert.match(html, /name="t" value="tok123"/);
	// A build with no Google client offers no button that cannot work.
	assert.ok(!chooserPage({ token: 'x', google: false }).includes('Continue with Google'));
});

test('nothing typed or sent back is written into a page as markup', () => {
	const evil = '"><img src=x onerror=alert(1)>';
	for (const html of [
		chooserPage({ token: 't', google: true, email: evil, error: evil, profile: evil }),
		codePage({ token: 't', email: evil, error: evil, notice: evil }),
		donePage({ email: evil, profile: evil }),
		failedPage(evil)
	]) {
		assert.ok(!html.includes('<img src=x'), html);
	}
});

test('the done page says whose session it is and what to type next, with the profile', () => {
	const html = donePage({ email: 'joel@solarpanda.com', profile: 'solarpanda' });
	assert.match(html, /Signed in/);
	assert.match(html, /joel@solarpanda\.com/);
	assert.match(html, /snoutdata projects list --profile solarpanda/);
	assert.ok(!donePage({}).includes('--profile'));
});

test('a failed sign-in says what happened and how to try again', () => {
	const html = failedPage('The user declined');
	assert.match(html, /Sign-in failed/);
	assert.match(html, /The user declined/);
	assert.match(html, /snoutdata login/);
});

test('the pages follow the system theme and honour reduced motion', () => {
	const html = donePage({});
	assert.match(html, /color-scheme: light dark/);
	assert.match(html, /prefers-reduced-motion: reduce/);
	// No em-dash in what a person reads (the design rule for user-facing text).
	for (const page of [chooserPage({ token: 't', google: true }), codePage({ token: 't', email: 'a@b.co' }), html, failedPage('x')]) {
		assert.ok(!page.replace(/<style>[\s\S]*?<\/style>/, '').includes('—'));
	}
});
