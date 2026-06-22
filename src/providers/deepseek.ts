/**
 * fairy-tales-deepseek-openai / deepseek-v4-pro provider adapter.
 *
 * This is now a barrel re-export. The implementation lives in
 * providers/deepseek/ — split into chat.ts (transport), planners.ts (fan-out),
 * synthesis.ts (draft reconciliation), repair.ts (verification repair), and
 * index.ts (AgentProvider orchestrator).
 */
export { deepseekProvider } from './deepseek/index.js';
