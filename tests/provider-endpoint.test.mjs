import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointForProtocol, endpointError } from '../src/provider-endpoint.ts';
test('protocol switching preserves host, API prefix and query', () => {
 const chat = 'https://example.com/custom/v1/chat/completions?region=cn';
 const responses = 'https://example.com/custom/v1/responses?region=cn';
 assert.equal(endpointForProtocol(chat, 'responses'), responses);
 assert.equal(endpointForProtocol(responses, 'chat_completions'), chat);
 assert.equal(endpointForProtocol('https://example.com/custom-route', 'responses'), 'https://example.com/custom-route');
});
test('reject unsupported protocols, base URLs and known mismatches', () => {
 for (const url of ['https://api.deepseek.com/anthropic', 'https://example.com/v1/messages', 'https://api.deepseek.com', 'https://example.com/v1', 'ftp://example.com/chat/completions', 'https://example.com/responses']) assert.ok(endpointError(url, 'chat_completions'));
 assert.ok(endpointError('https://example.com/chat/completions', 'responses'));
 assert.equal(endpointError('https://api.deepseek.com/chat/completions', 'chat_completions'), '');
 assert.equal(endpointError('http://127.0.0.1:11434/custom-route', 'chat_completions'), '');
 assert.equal(endpointError('https://example.com/v1/responses', 'responses'), '');
});
