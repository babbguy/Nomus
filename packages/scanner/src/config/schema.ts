import { z } from 'zod';

export const nomusConfigSchema = z.object({
  nomus: z.object({
    api_key: z.string().optional(), // Can come from env var
    api_url: z.string().url().default('http://localhost:3100'),
    jurisdictions: z.array(z.string()).min(1),
    sector: z.string().optional(),
    data_types: z.array(z.string()).default([]),
    ignore: z.array(z.string()).default(['node_modules/**', 'dist/**', '.git/**', '**/*.test.*', '**/*.spec.*']),
    detectors: z.object({
      import: z.boolean().default(true),
      sdk_usage: z.boolean().default(true),
      phi_pattern: z.boolean().default(true),
      risk_classifier: z.boolean().default(true),
      data_flow: z.boolean().default(true),
      transparency: z.boolean().default(true),
    }).default({}),
    max_taint_depth: z.number().int().min(1).max(10).default(3),
  }),
});

export type NomusConfig = z.infer<typeof nomusConfigSchema>;
