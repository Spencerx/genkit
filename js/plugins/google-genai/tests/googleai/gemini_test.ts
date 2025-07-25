/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as assert from 'assert';
import { Genkit, z } from 'genkit';
import { GenerateRequest } from 'genkit/model';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sinon from 'sinon';
import {
  GeminiConfigSchema,
  GeminiTtsConfigSchema,
  defineModel,
  model,
} from '../../src/googleai/gemini';
import {
  FinishReason,
  GenerateContentRequest,
  GenerateContentResponse,
  GoogleAIPluginOptions,
} from '../../src/googleai/types';
import { MISSING_API_KEY_ERROR } from '../../src/googleai/utils';

describe('Google AI Gemini', () => {
  let mockGenkit: sinon.SinonStubbedInstance<Genkit>;
  const ORIGINAL_ENV = { ...process.env };

  let modelActionCallback: (
    request: GenerateRequest<typeof GeminiConfigSchema>,
    options: {
      streamingRequested?: boolean;
      sendChunk?: (chunk: any) => void;
      abortSignal?: AbortSignal;
    }
  ) => Promise<any>;

  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;

    mockGenkit = sinon.createStubInstance(Genkit);

    // Setup mock registry and asyncStore
    const mockAsyncStore = sinon.createStubInstance(AsyncLocalStorage);
    mockAsyncStore.getStore.returns(undefined); // Simulate no parent span
    mockAsyncStore.run.callsFake((key, store, callback) => callback());

    (mockGenkit as any).registry = {
      lookupAction: () => undefined,
      lookupFlow: () => undefined,
      generateTraceId: () => 'test-trace-id',
      asyncStore: mockAsyncStore,
    };

    fetchStub = sinon.stub(global, 'fetch');

    mockGenkit.defineModel.callsFake((config: any, callback: any) => {
      modelActionCallback = callback;
      return {
        name: config.name,
      } as any;
    });
  });

  afterEach(() => {
    sinon.restore();
    process.env = { ...ORIGINAL_ENV };
  });

  // Mock fetch for non-streaming responses
  function mockFetchResponse(body: any, status = 200) {
    const response = new Response(JSON.stringify(body), {
      status: status,
      statusText: status === 200 ? 'OK' : 'Error',
      headers: { 'Content-Type': 'application/json' },
    });
    fetchStub.resolves(response);
  }

  // Mock fetch for streaming responses (SSE)
  function mockFetchStreamResponse(responses: GenerateContentResponse[]) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const response of responses) {
          const chunk = `data: ${JSON.stringify(response)}\n\n`;
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });

    const response = new Response(stream, {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'text/event-stream' },
    });
    fetchStub.resolves(response);
  }

  const defaultPluginOptions: GoogleAIPluginOptions = {
    apiKey: 'test-api-key-plugin',
  };

  const minimalRequest: GenerateRequest<typeof GeminiConfigSchema> = {
    messages: [{ role: 'user', content: [{ text: 'Hello' }] }],
  };

  const mockCandidate = {
    index: 0,
    content: { role: 'model', parts: [{ text: 'Hi there' }] },
    finishReason: 'STOP' as FinishReason,
  };

  const defaultApiResponse: GenerateContentResponse = {
    candidates: [mockCandidate],
  };

  describe('defineGeminiModel', () => {
    it('defines a model with the correct name for known model', () => {
      defineModel(mockGenkit, 'gemini-2.0-flash', defaultPluginOptions);
      sinon.assert.calledOnce(mockGenkit.defineModel);
      const args = mockGenkit.defineModel.lastCall.args[0];
      assert.strictEqual(args.name, 'googleai/gemini-2.0-flash');
    });

    it('defines a model with a custom name', () => {
      defineModel(mockGenkit, 'my-custom-gemini', defaultPluginOptions);
      const args = mockGenkit.defineModel.lastCall.args[0];
      assert.strictEqual(args.name, 'googleai/my-custom-gemini');
    });

    describe('API Key Handling', () => {
      it('throws if no API key is provided', () => {
        assert.throws(() => {
          defineModel(mockGenkit, 'gemini-2.0-flash');
        }, MISSING_API_KEY_ERROR);
      });

      it('uses API key from pluginOptions', async () => {
        defineModel(mockGenkit, 'gemini-2.0-flash', {
          apiKey: 'plugin-key',
        });
        mockFetchResponse(defaultApiResponse);
        await modelActionCallback(minimalRequest, {});
        sinon.assert.calledOnce(fetchStub);
        const fetchOptions = fetchStub.lastCall.args[1];
        assert.strictEqual(
          fetchOptions.headers['x-goog-api-key'],
          'plugin-key'
        );
      });

      it('uses API key from GEMINI_API_KEY env var', async () => {
        process.env.GEMINI_API_KEY = 'gemini-key';
        defineModel(mockGenkit, 'gemini-2.0-flash');
        mockFetchResponse(defaultApiResponse);
        await modelActionCallback(minimalRequest, {});
        const fetchOptions = fetchStub.lastCall.args[1];
        assert.strictEqual(
          fetchOptions.headers['x-goog-api-key'],
          'gemini-key'
        );
      });

      it('throws if apiKey is false and not in call config', async () => {
        defineModel(mockGenkit, 'gemini-2.0-flash', { apiKey: false });
        await assert.rejects(
          modelActionCallback(minimalRequest, {}),
          /GoogleAI plugin was initialized with \{apiKey: false\}/
        );
        sinon.assert.notCalled(fetchStub);
      });

      it('uses API key from call config if apiKey is false', async () => {
        defineModel(mockGenkit, 'gemini-2.0-flash', { apiKey: false });
        mockFetchResponse(defaultApiResponse);
        const request: GenerateRequest<typeof GeminiConfigSchema> = {
          ...minimalRequest,
          config: { apiKey: 'call-time-key' },
        };
        await modelActionCallback(request, {});
        const fetchOptions = fetchStub.lastCall.args[1];
        assert.strictEqual(
          fetchOptions.headers['x-goog-api-key'],
          'call-time-key'
        );
      });
    });

    describe('Request Formation and API Calls', () => {
      beforeEach(() => {
        defineModel(mockGenkit, 'gemini-2.5-flash', defaultPluginOptions);
      });

      it('calls fetch for non-streaming requests', async () => {
        mockFetchResponse(defaultApiResponse);
        await modelActionCallback(minimalRequest, {
          streamingRequested: false,
        });
        sinon.assert.calledOnce(fetchStub);

        const fetchArgs = fetchStub.lastCall.args;
        const url = fetchArgs[0];
        const options = fetchArgs[1];

        assert.ok(url.includes('models/gemini-2.5-flash:generateContent'));
        assert.strictEqual(options.method, 'POST');
        assert.strictEqual(
          options.headers['x-goog-api-key'],
          'test-api-key-plugin'
        );
        const body = JSON.parse(options.body);
        assert.deepStrictEqual(body.contents, [
          { role: 'user', parts: [{ text: 'Hello' }] },
        ]);
      });

      it('calls fetch for streaming requests', async () => {
        mockFetchStreamResponse([defaultApiResponse]);

        const sendChunkSpy = sinon.spy();
        await modelActionCallback(minimalRequest, {
          streamingRequested: true,
          sendChunk: sendChunkSpy,
        });

        sinon.assert.calledOnce(fetchStub);
        const fetchArgs = fetchStub.lastCall.args;
        const url = fetchArgs[0];
        assert.ok(
          url.includes('models/gemini-2.5-flash:streamGenerateContent')
        );
        assert.ok(url.includes('alt=sse'));

        await new Promise((resolve) => setTimeout(resolve, 10)); // Allow stream to process

        sinon.assert.calledOnce(sendChunkSpy);
        const chunkArg = sendChunkSpy.lastCall.args[0];
        assert.deepStrictEqual(chunkArg, {
          index: 0,
          content: [{ text: 'Hi there' }],
        });
      });

      it('passes AbortSignal to fetch', async () => {
        mockFetchResponse(defaultApiResponse);
        const controller = new AbortController();
        const abortSignal = controller.signal;
        await modelActionCallback(minimalRequest, {
          streamingRequested: false,
          abortSignal,
        });
        sinon.assert.calledOnce(fetchStub);
        const fetchOptions = fetchStub.lastCall.args[1];
        assert.ok(fetchOptions.signal, 'Fetch options should have a signal');
        assert.notStrictEqual(
          fetchOptions.signal,
          abortSignal,
          'Fetch signal should be a new signal, not the original'
        );

        const fetchSignal = fetchOptions.signal;
        const abortSpy = sinon.spy();
        fetchSignal.addEventListener('abort', abortSpy);
        controller.abort();
        sinon.assert.calledOnce(abortSpy);
      });

      it('handles system instructions', async () => {
        mockFetchResponse(defaultApiResponse);
        const request: GenerateRequest<typeof GeminiConfigSchema> = {
          messages: [
            { role: 'system', content: [{ text: 'Be concise' }] },
            { role: 'user', content: [{ text: 'Hello' }] },
          ],
        };
        await modelActionCallback(request, {});

        const apiRequest: GenerateContentRequest = JSON.parse(
          fetchStub.lastCall.args[1].body
        );
        assert.deepStrictEqual(apiRequest.systemInstruction, {
          role: 'user',
          parts: [{ text: 'Be concise' }],
        });
        assert.deepStrictEqual(apiRequest.contents, [
          { role: 'user', parts: [{ text: 'Hello' }] },
        ]);
      });

      it('constructs tools array correctly', async () => {
        mockFetchResponse(defaultApiResponse);
        const request: GenerateRequest<typeof GeminiConfigSchema> = {
          ...minimalRequest,
          tools: [
            {
              name: 'myFunc',
              description: 'Does something',
              inputSchema: z.object({ foo: z.string() }),
              outputSchema: z.string(),
            },
          ],
          config: {
            codeExecution: true,
            googleSearchRetrieval: {},
          },
        };
        await modelActionCallback(request, {});

        const apiRequest: GenerateContentRequest = JSON.parse(
          fetchStub.lastCall.args[1].body
        );
        assert.ok(Array.isArray(apiRequest.tools));
        assert.strictEqual(apiRequest.tools?.length, 3);
        assert.deepStrictEqual(apiRequest.tools?.[1], { codeExecution: {} });
        assert.deepStrictEqual(apiRequest.tools?.[2], {
          googleSearch: {},
        });
      });
    });

    describe('Error Handling', () => {
      beforeEach(() => {
        defineModel(mockGenkit, 'gemini-2.0-flash', defaultPluginOptions);
      });

      it('throws if no candidates are returned', async () => {
        mockFetchResponse({ candidates: [] });
        await assert.rejects(
          modelActionCallback(minimalRequest, {}),
          /No valid candidates returned/
        );
      });

      it('throws on fetch error', async () => {
        fetchStub.rejects(new Error('Network error'));
        await assert.rejects(
          modelActionCallback(minimalRequest, {}),
          /Failed to fetch/
        );
      });
    });

    describe('Debug Traces', () => {
      it('API call works with debugTraces: true', async () => {
        defineModel(mockGenkit, 'gemini-2.5-flash', {
          ...defaultPluginOptions,
          experimental_debugTraces: true,
        });

        mockFetchResponse(defaultApiResponse);
        await assert.doesNotReject(modelActionCallback(minimalRequest, {}));
        sinon.assert.calledOnce(fetchStub);
      });

      it('API call works with debugTraces: false', async () => {
        defineModel(mockGenkit, 'gemini-2.0-flash', {
          ...defaultPluginOptions,
          experimental_debugTraces: false,
        });

        mockFetchResponse(defaultApiResponse);
        await assert.doesNotReject(modelActionCallback(minimalRequest, {}));
        sinon.assert.calledOnce(fetchStub);
      });
    });
  });

  describe('gemini() function', () => {
    it('returns a ModelReference for a known model string', () => {
      const name = 'gemini-2.0-flash';
      const modelRef = model(name);
      assert.strictEqual(modelRef.name, `googleai/${name}`);
      assert.strictEqual(modelRef.info?.supports?.multiturn, true);
      assert.strictEqual(modelRef.configSchema, GeminiConfigSchema);
    });

    it('returns a ModelReference for a tts type model string', () => {
      const name = 'gemini-2.5-flash-preview-tts';
      const modelRef = model(name);
      assert.strictEqual(modelRef.name, `googleai/${name}`);
      assert.strictEqual(modelRef.info?.supports?.multiturn, false);
      assert.strictEqual(modelRef.configSchema, GeminiTtsConfigSchema);
    });

    it('returns a ModelReference for an unknown model string', () => {
      const name = 'gemini-3.0-flash';
      const modelRef = model(name);
      assert.strictEqual(modelRef.name, `googleai/${name}`);
      assert.strictEqual(modelRef.info?.supports?.multiturn, true);
      assert.strictEqual(modelRef.configSchema, GeminiConfigSchema);
    });
  });
});
