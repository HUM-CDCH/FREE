import type { InferAgentUIMessage } from "ai";
import type { SchemaAgent } from "../api/_chat_agent.js";

export type SchemaAgentUIMessage = InferAgentUIMessage<SchemaAgent>;
