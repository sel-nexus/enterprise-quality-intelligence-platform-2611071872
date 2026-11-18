/** Fail every browser journey on unexpected console, page, or network errors. */
import { test as base, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export { expect };
export const test = base.extend<{ browserErrors: { expectHttpError: (method: string, path: string, status: number, count?: number) => void } }>({
  browserErrors: [async ({ context, page }, use) => {
    const consoleErrors: { page: Page; text: string; url: string }[] = [];
    const otherErrors: string[] = [];
    const responses: { page: Page; method: string; path: string; url: string; status: number }[] = [];
    const expected: { method: string; path: string; status: number; count: number }[] = [];
    const watch = (watched: Page) => {
      watched.on('console', message => {
        if (message.type() === 'error') consoleErrors.push({ page: watched, text: message.text(), url: message.location().url });
      });
      watched.on('pageerror', error => otherErrors.push(`Page error: ${error.message}`));
      watched.on('requestfailed', request => otherErrors.push(`Request failed: ${request.url()}: ${request.failure()?.errorText}`));
      watched.on('response', response => {
        if (response.status() >= 400) responses.push({ page: watched, method: response.request().method(), path: new URL(response.url()).pathname, url: response.url(), status: response.status() });
      });
    };
    context.on('page', watch);
    watch(page);
    await use({ expectHttpError: (method, path, status, count = 1) => {
      if (!Number.isInteger(count) || count < 1) throw new Error('Expected HTTP error count must be a positive integer');
      expected.push({ method, path, status, count });
    } });
    context.off('page', watch);
    const remaining = expected.map(item => ({ ...item }));
    for (const response of responses) {
      const allowance = remaining.find(item => item.method === response.method && item.path === response.path && item.status === response.status && item.count > 0);
      if (allowance) allowance.count--;
      else otherErrors.push(`Unexpected HTTP ${response.method} ${response.path}: ${response.status}`);
    }
    for (const item of remaining) if (item.count) otherErrors.push(`Missing ${item.count} HTTP ${item.method} ${item.path}: ${item.status}`);
    // Each Chromium resource error consumes one distinct response from the same
    // page and URL. The response accounting above independently checks its method.
    const unmatchedResponses = [...responses];
    for (const error of consoleErrors) {
      const match = /^Failed to load resource: the server responded with a status of (\d{3})(?:\s|$)/.exec(error.text);
      const index = match ? unmatchedResponses.findIndex(response => response.page === error.page && response.url === error.url && response.status === Number(match[1])) : -1;
      if (index < 0) otherErrors.push(`Console: ${error.text} (${error.url})`);
      else unmatchedResponses.splice(index, 1);
    }
    for (const response of unmatchedResponses) otherErrors.push(`Missing console error for HTTP ${response.method} ${response.path}: ${response.status}`);
    expect(otherErrors).toEqual([]);
  }, { auto: true }],
});
