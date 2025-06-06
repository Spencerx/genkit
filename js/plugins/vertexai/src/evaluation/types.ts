/**
 * Copyright 2024 Google LLC
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

import type { CommonPluginOptions } from '../common/types.js';

export enum VertexAIEvaluationMetricType {
  // Update genkit/docs/plugins/vertex-ai.md when modifying the list of enums
  BLEU = 'BLEU',
  ROUGE = 'ROUGE',
  FLUENCY = 'FLEUNCY',
  SAFETY = 'SAFETY',
  GROUNDEDNESS = 'GROUNDEDNESS',
  SUMMARIZATION_QUALITY = 'SUMMARIZATION_QUALITY',
  SUMMARIZATION_HELPFULNESS = 'SUMMARIZATION_HELPFULNESS',
  SUMMARIZATION_VERBOSITY = 'SUMMARIZATION_VERBOSITY',
}

/**
 * Evaluation metric config. Use `metricSpec` to define the behavior of the metric.
 * The value of `metricSpec` will be included in the request to the API. See the API documentation
 * for details on the possible values of `metricSpec` for each metric.
 * https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/evaluation#parameter-list
 */
export type VertexAIEvaluationMetricConfig = {
  type: VertexAIEvaluationMetricType;
  metricSpec: any;
};

export type VertexAIEvaluationMetric =
  | VertexAIEvaluationMetricType
  | VertexAIEvaluationMetricConfig;

/** Options specific to evaluation configuration */
export interface EvaluationOptions {
  metrics: VertexAIEvaluationMetric[];
}

export interface PluginOptions extends CommonPluginOptions, EvaluationOptions {}
