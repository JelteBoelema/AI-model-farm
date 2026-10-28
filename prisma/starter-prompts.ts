// Starter prompt templates installed by the seed (version 1, published).
import type { PromptKind } from "@prisma/client";

export type StarterVar = { name: string; type: "text" | "longtext" | "number" | "enum" | "boolean"; label?: string; required?: boolean; options?: string[]; default?: string; min?: number; max?: number };

export const STARTER_PROMPTS: { key: string; name: string; kind: PromptKind; body: string; variables: StarterVar[] }[] = [
  {
    key: "image.lifestyle.default",
    name: "Lifestyle photo",
    kind: "IMAGE",
    body: "{{creator_identity_prompt}}. Candid lifestyle photograph, {{scene}}, natural light, {{camera}}. Aspect ratio {{aspect_ratio}}.",
    variables: [
      { name: "scene", type: "text", label: "Scene" },
      { name: "camera", type: "text", label: "Camera & lens", default: "35mm lens, shallow depth of field" },
      { name: "aspect_ratio", type: "enum", label: "Aspect ratio", options: ["1:1", "4:5", "9:16"], default: "4:5" },
    ],
  },
  {
    key: "script.short_video.default",
    name: "Short video script",
    kind: "SCRIPT",
    body: "Write a {{duration_seconds}}-second vertical video script for {{creator_name}} (tone: {{creator_tone}}) about {{topic}}. Return scenes with action, dialogue and on-screen text.{{#if hook}} Open with a strong hook in the first two seconds.{{/if}}",
    variables: [
      { name: "duration_seconds", type: "number", label: "Duration (s)", min: 5, max: 90, default: "30" },
      { name: "topic", type: "text", label: "Topic" },
      { name: "hook", type: "boolean", label: "Start with a hook", default: "true" },
    ],
  },
  {
    key: "caption.default",
    name: "Caption",
    kind: "CAPTION",
    body: "Write a {{platform}} caption in {{creator_language}} for {{creator_name}} about {{topic}}. At most {{max_chars}} characters. End with this disclosure: {{ai_disclosure}}",
    variables: [
      { name: "platform", type: "enum", label: "Platform", options: ["instagram", "tiktok", "youtube"], default: "instagram" },
      { name: "topic", type: "text", label: "Topic" },
      { name: "max_chars", type: "number", label: "Max characters", min: 50, max: 2200, default: "2200" },
      { name: "ai_disclosure", type: "text", label: "AI disclosure", default: "Made with AI" },
    ],
  },
  {
    key: "safety.rules.global",
    name: "Global safety rules",
    kind: "SAFETY_RULES",
    body: "Never depict or imitate real, identifiable people. No minors. No medical, financial or political claims. Follow platform AI-content labelling rules.",
    variables: [],
  },
];

