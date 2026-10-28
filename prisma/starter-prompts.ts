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
    key: "video.scene.default",
    name: "Video scene",
    kind: "VIDEO",
    body: "{{creator_identity_prompt}}. {{scene}}.{{#if action}} Action: {{action}}.{{/if}} Vertical 9:16 video, {{camera}}, natural motion, no text or logos in frame.",
    variables: [
      { name: "scene", type: "longtext", label: "Scene" },
      { name: "action", type: "text", label: "Action", required: false },
      { name: "camera", type: "text", label: "Camera", default: "handheld smartphone look, shallow depth of field" },
    ],
  },
  {
    key: "script.short_video.default",
    name: "Short video script",
    kind: "SCRIPT",
    body: "Write a storyboard for a vertical (9:16) video of about {{duration_seconds}} seconds for {{creator_name}} (tone: {{creator_tone}}; language: {{creator_language}}) about {{topic}}, in exactly {{scenes}} scenes.{{#if brief}}\n\nBrief:\n{{brief}}{{/if}}\n\nPer scene: the visual for a video model (setting, framing, light, motion; the character itself is described separately), the action, the clip length, one spoken voice-over line that fits the clip (about 14 characters per second; may be empty) and short on-screen text. Keep the character, styling and setting consistent.{{#if hook}} Open with a strong hook in the first two seconds.{{/if}}",
    variables: [
      { name: "duration_seconds", type: "number", label: "Duration (s)", min: 5, max: 90, default: "30" },
      { name: "topic", type: "text", label: "Topic" },
      { name: "hook", type: "boolean", label: "Start with a hook", default: "true" },
      { name: "scenes", type: "number", label: "Scenes", min: 1, max: 10, default: "3" },
      { name: "brief", type: "longtext", label: "Brief", required: false },
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
    key: "brief.default",
    name: "Content brief",
    kind: "IDEATION",
    body: "Turn this idea into a brief for a {{format}} by {{creator_name}} (niche: {{creator_niche}}; audience: {{creator_audience}}; tone: {{creator_tone}}).\n\nTitle: {{title}}\nIdea: {{idea}}{{#if campaign_context}}\nCampaign: {{campaign_context}}{{/if}}\n\nGive the angle, a scroll-stopping hook, the single key message, the visual direction (setting, styling, mood, light) and the content pillar it belongs to.",
    variables: [
      { name: "format", type: "text", label: "Format" },
      { name: "title", type: "text", label: "Title" },
      { name: "idea", type: "longtext", label: "Idea" },
      { name: "campaign_context", type: "longtext", label: "Campaign context", required: false },
    ],
  },
  {
    key: "script.photo.default",
    name: "Photo shot list",
    kind: "SCRIPT",
    body: "Plan exactly {{shots}} photo(s) for a {{format}} by {{creator_name}} based on this brief:\n{{brief}}\n\nFor each photo describe the scene for an image model (setting, pose, action, wardrobe, light, framing; the character itself is described separately) and its purpose in the post. Keep the character, styling and setting consistent across photos.",
    variables: [
      { name: "shots", type: "number", label: "Number of photos", min: 1, max: 10, default: "1" },
      { name: "format", type: "text", label: "Format" },
      { name: "brief", type: "longtext", label: "Brief" },
    ],
  },
  {
    key: "qc.rubric.default",
    name: "Quality rubric",
    kind: "QUALITY_RULES",
    body: "Score 0-100. Fail (error) on: the person does not match the reference character; extra or malformed fingers, limbs or teeth; garbled text in the image; a real brand logo or recognisable real person; anything sexual, violent or involving minors; a caption with medical, financial or political claims. Warn on: off-brief scene, inconsistent styling between photos, weak hook, caption longer than needed.",
    variables: [],
  },
  {
    key: "safety.rules.global",
    name: "Global safety rules",
    kind: "SAFETY_RULES",
    body: "Never depict or imitate real, identifiable people. No minors. No medical, financial or political claims. Follow platform AI-content labelling rules.",
    variables: [],
  },
];

