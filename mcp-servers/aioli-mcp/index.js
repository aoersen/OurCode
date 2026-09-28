#!/usr/bin/env node
/**
 * Aioli Design System — MCP Server
 *
 * Exposes Aioli's design system intelligence via Model Context Protocol.
 * Any AI assistant (Claude, Cursor, Copilot) can use these tools to generate
 * accessible, themed, production-quality UI components and pages.
 *
 * Transport: stdio (local, self-hosted, no API keys)
 *
 * Setup (Claude Desktop):
 *   Add to ~/Library/Application Support/Claude/claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "aioli": {
 *         "command": "node",
 *         "args": ["/path/to/aioli/mcp-server/index.js"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// Aioli imports
import { createAgentSystem } from '../../node_modules/aioli-design/agents/index.js';
import { listPresets, getPresetOverrides, derivePalette, deriveBrandTheme, suggestHarmonies, validateTheme, auditTheme } from '../../node_modules/aioli-design/lib/theme-presets.js';
import { createTheme } from '../../node_modules/aioli-design/lib/theme.js';
import { validateThemeFile, importThemeFile, exportThemeFile } from '../../node_modules/aioli-design/lib/theme-file.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const tokensPath = resolve(__dirname, '..', '..', 'node_modules', 'aioli-design', 'tokens');

// stdout carries the MCP JSON-RPC stream only. The aioli library logs startup
// banners via console.log (e.g. "🎨 Design Token Agent: Loaded N tokens"),
// which would corrupt the stdio protocol — route all library logs to stderr.
console.log = console.error.bind(console);

// Create agent system once at startup — reused across all tool calls
const agents = createAgentSystem(tokensPath);
console.error('Aioli MCP Server: Agent system initialized (1,754 tokens loaded)');

// Load community components if registry exists
const projectRoot = resolve(__dirname, '..', '..', 'node_modules', 'aioli-design');
if (existsSync(resolve(projectRoot, '.aioli', 'registry.json'))) {
  agents.loadCommunityComponents(projectRoot).then(count => {
    if (count > 0) console.error(`Aioli MCP Server: Loaded ${count} community component(s)`);
  }).catch(() => {
    // Silently continue — community loading is optional
  });
}

// Create MCP server
const server = new McpServer({
  name: 'aioli-design-system',
  version: '1.0.0',
});

// ============================================================================
// HELPER: Safe tool handler wrapper
// ============================================================================

function safeResult(data) {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: `Error: ${error.message || error}` }],
    isError: true,
  };
}

// ============================================================================
// TOOL 1: generate_component
// ============================================================================

server.tool(
  'generate_component',
  'Generate an accessible UI component from a natural language description. ' +
  'Supports 55 component types, 8 style modifiers (glass, gradient, neumorphic, brutalist, ' +
  'elevated, dark-luxury, colored-shadow, animated), and auto-detects page compositions. ' +
  'All output is WCAG AA accessible with semantic HTML. ' +
  'Use output_format to get React, Vue, or Svelte component code instead of raw HTML.',
  {
    description: z.string().describe(
      'Natural language description of the component, e.g. "glassmorphic card with title and image", ' +
      '"large primary button with icon", "neumorphic input field"'
    ),
    output_format: z.enum(['html', 'react', 'vue', 'svelte']).optional().default('html').describe(
      'Output format: html (default), react (JSX component), vue (SFC), or svelte'
    ),
  },
  async ({ description, output_format }) => {
    try {
      const format = output_format || 'html';
      const result = agents.component.handleRequest({
        action: 'generateFromDescription',
        description,
        format,
      });
      if (!result.success) return errorResult(result.error || 'Generation failed');
      const data = {
        type: result.data.type,
        category: result.data.category,
        html: result.data.html,
        tokens: result.data.tokens,
        a11y: result.data.a11y,
      };
      if (format !== 'html') {
        data.code = result.data.code;
        data.framework = result.data.framework;
        data.componentName = result.data.componentName;
      }
      return safeResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 2: generate_page
// ============================================================================

server.tool(
  'generate_page',
  'Generate a full multi-section page layout from a description. ' +
  'Supports 4 page types: marketing, dashboard, blog, pricing. ' +
  'Returns complete HTML with hero, features, stats, CTA sections as appropriate. ' +
  'Use output_format to get React, Vue, or Svelte component code instead of raw HTML.',
  {
    description: z.string().describe(
      'Page description, e.g. "marketing landing page", "dashboard page with stats", ' +
      '"blog page with sidebar", "pricing page with 3 tiers"'
    ),
    output_format: z.enum(['html', 'react', 'vue', 'svelte']).optional().default('html').describe(
      'Output format: html (default), react (JSX component), vue (SFC), or svelte'
    ),
  },
  async ({ description, output_format }) => {
    try {
      const format = output_format || 'html';
      const result = agents.component.handleRequest({
        action: 'generatePageComposition',
        description,
        format,
      });
      if (!result.success) return errorResult(result.error || 'Page generation failed');
      const data = {
        type: result.data.type,
        pageType: result.data.pageType,
        html: result.data.html,
        sectionCount: result.data.sectionCount,
        sections: result.data.sections?.map(s => s.type),
        tokens: result.data.tokens,
        a11y: result.data.a11y,
      };
      if (format !== 'html') {
        data.code = result.data.code;
        data.framework = result.data.framework;
        data.componentName = result.data.componentName;
      }
      return safeResult(data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 3: list_components
// ============================================================================

server.tool(
  'list_components',
  'List all 55 available Aioli component templates with their categories, ' +
  'descriptions, supported variants, and sizes. Use this to discover what ' +
  'components are available before generating.',
  {},
  async () => {
    try {
      const result = agents.component.handleRequest({ action: 'listComponents' });
      if (!result.success) return errorResult(result.error);
      return safeResult(result.data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 4: list_style_modifiers
// ============================================================================

server.tool(
  'list_style_modifiers',
  'List all available style modifiers (glass, gradient, neumorphic, brutalist, etc.) ' +
  'and page composition types (marketing, dashboard, blog, pricing). ' +
  'Use these in component descriptions to apply visual styles.',
  {},
  async () => {
    try {
      const modifiers = agents.component.handleRequest({ action: 'listStyleModifiers' });
      const compositions = agents.component.handleRequest({ action: 'listPageCompositions' });
      return safeResult({
        styleModifiers: modifiers.success ? modifiers.data : [],
        pageCompositions: compositions.success ? compositions.data : [],
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 5: list_themes
// ============================================================================

server.tool(
  'list_themes',
  'List all 6 available Aioli theme presets: default (clean/professional), ' +
  'glass (glassmorphism), neumorphic (soft shadows), brutalist (thick borders), ' +
  'gradient (vibrant gradients), darkLuxury (dark + gold accents). ' +
  'All themes are WCAG AA accessible.',
  {},
  async () => {
    try {
      return safeResult(listPresets());
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 6: get_theme_css
// ============================================================================

server.tool(
  'get_theme_css',
  'Get CSS custom properties for a theme preset. Returns a complete :root { } block ' +
  'with all token overrides that can be included in a stylesheet to apply the theme.',
  {
    theme: z.enum(['default', 'glass', 'neumorphic', 'brutalist', 'gradient', 'darkLuxury'])
      .describe('Theme preset name'),
    customOverrides: z.record(z.string(), z.string()).optional()
      .describe('Optional additional token overrides to merge with the preset, e.g. {"semantic.color.primary.default": "#8b5cf6"}'),
  },
  async ({ theme, customOverrides }) => {
    try {
      const overrides = getPresetOverrides(theme, customOverrides || {});
      const themeObj = createTheme(overrides);
      return safeResult({
        theme,
        css: themeObj.toCSS(),
        overrideCount: Object.keys(overrides).length,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 7: derive_palette
// ============================================================================

server.tool(
  'derive_palette',
  'Generate a full accessible color palette from a single brand color. ' +
  'Derives primary, hover, active, subtle, muted, dark mode variants, gradients, ' +
  'and colored shadows — all WCAG AA verified. Returns token overrides and CSS.',
  {
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
      .describe('Brand color as 6-digit hex, e.g. "#2563eb"'),
  },
  async ({ color }) => {
    try {
      const palette = derivePalette(color);
      const themeObj = createTheme(palette);
      return safeResult({
        sourceColor: color,
        tokenOverrides: palette,
        css: themeObj.toCSS(),
        tokenCount: Object.keys(palette).length,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 8: get_tokens
// ============================================================================

server.tool(
  'get_tokens',
  'Query Aioli design tokens. Get a single token by path, filter by prefix, ' +
  'or export all tokens as CSS custom properties or JSON. ' +
  'The system has 1,754 tokens across primitives, semantic, and component tiers.',
  {
    path: z.string().optional()
      .describe('Dot-notation token path, e.g. "semantic.color.primary.default"'),
    prefix: z.string().optional()
      .describe('Filter tokens by prefix, e.g. "semantic.color" or "component.button"'),
    format: z.enum(['json', 'css']).optional()
      .describe('Export format: "json" for all resolved tokens, "css" for CSS custom properties'),
  },
  async ({ path, prefix, format }) => {
    try {
      // Single token lookup
      if (path) {
        const result = agents.token.handleRequest({ action: 'get', path });
        if (!result.success) return errorResult(result.error || `Token not found: ${path}`);
        return safeResult(result.data);
      }
      // Filtered list
      if (prefix) {
        const result = agents.token.handleRequest({ action: 'list', prefix });
        if (!result.success) return errorResult(result.error);
        return safeResult(result.data);
      }
      // Full export
      if (format === 'css') {
        const result = agents.token.handleRequest({ action: 'css' });
        if (!result.success) return errorResult(result.error);
        return safeResult(result.data);
      }
      if (format === 'json') {
        const result = agents.token.handleRequest({ action: 'json' });
        if (!result.success) return errorResult(result.error);
        return safeResult(result.data);
      }
      // Default: summary
      const count = agents.token.countTokens();
      const paths = agents.token.getAllTokenPaths();
      const prefixes = [...new Set(paths.map(p => p.split('.').slice(0, 2).join('.')))].sort();
      return safeResult({
        totalTokens: count,
        topLevelCategories: prefixes,
        hint: 'Use "path" for a single token, "prefix" to filter, or "format" to export all.',
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 9: resolve_token
// ============================================================================

server.tool(
  'resolve_token',
  'Resolve a design token reference to its final computed value, showing the ' +
  'full reference chain. Useful for understanding how semantic tokens map to primitives.',
  {
    reference: z.string()
      .describe('Token reference to resolve, e.g. "{semantic.color.primary.default}" or just "semantic.color.primary.default"'),
  },
  async ({ reference }) => {
    try {
      // Normalize: add braces if not present
      const ref = reference.startsWith('{') ? reference : `{${reference}}`;
      const result = agents.token.handleRequest({ action: 'resolve', reference: ref });
      if (!result.success) return errorResult(result.error || `Could not resolve: ${reference}`);
      return safeResult(result.data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 10: check_contrast
// ============================================================================

server.tool(
  'check_contrast',
  'Check WCAG contrast ratio between two colors. Returns the ratio and whether ' +
  'it passes AA (4.5:1 for text, 3:1 for UI) and AAA (7:1) standards. ' +
  'Accepts hex colors (#rrggbb) or Aioli token references.',
  {
    foreground: z.string()
      .describe('Foreground (text) color as hex or token reference, e.g. "#0f172a" or "{semantic.text.default}"'),
    background: z.string()
      .describe('Background color as hex or token reference, e.g. "#ffffff" or "{semantic.surface.page.default}"'),
    level: z.enum(['AA', 'AAA']).optional().default('AA')
      .describe('WCAG level to check against (default: AA)'),
  },
  async ({ foreground, background, level }) => {
    try {
      const result = agents.a11y.handleRequest({
        action: 'checkContrast',
        foreground,
        background,
        options: { level },
      });
      if (!result.success) return errorResult(result.error);
      return safeResult(result.data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 11: validate_accessibility
// ============================================================================

server.tool(
  'validate_accessibility',
  'Run a full WCAG accessibility audit on HTML code. Checks semantic HTML, ' +
  'ARIA attributes, heading hierarchy, form labels, image alt text, and more. ' +
  'Optionally include CSS to also validate motion/animation compliance.',
  {
    html: z.string()
      .describe('HTML code to validate'),
    css: z.string().optional()
      .describe('Optional CSS to validate for motion/animation compliance'),
    componentName: z.string().optional()
      .describe('Optional component name for the report'),
  },
  async ({ html, css, componentName }) => {
    try {
      if (css) {
        // Full component validation (HTML + ARIA + motion)
        const result = agents.a11y.handleRequest({
          action: 'validateComponent',
          component: { name: componentName || 'Component', html, css },
        });
        if (!result.success) return errorResult(result.error);
        return safeResult(result.data);
      }
      // HTML-only validation
      const result = agents.a11y.handleRequest({
        action: 'validateHTML',
        code: html,
        componentName: componentName || 'Component',
      });
      if (!result.success) return errorResult(result.error);
      return safeResult(result.data);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 12: review_code
// ============================================================================

server.tool(
  'review_code',
  'Get a comprehensive code quality review with a score (0-100), letter grade, ' +
  'and detailed feedback across 6 categories: tokens, accessibility, motion, ' +
  'structure, patterns, and performance.',
  {
    html: z.string()
      .describe('HTML code to review'),
    css: z.string().optional()
      .describe('Optional CSS code to review'),
  },
  async ({ html, css }) => {
    try {
      const result = agents.codeReview.handleRequest({
        action: 'review',
        code: { html, css: css || '' },
      });
      if (!result.success) return errorResult(result.error);
      const data = result.data;
      return safeResult({
        approved: data.approved,
        score: data.score,
        grade: data.grade,
        summary: data.summary,
        issueCount: data.issues?.length || 0,
        issues: data.issues,
        suggestions: data.suggestions,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 13: derive_brand_theme
// ============================================================================

server.tool(
  'derive_brand_theme',
  'Generate a complete brand theme from multiple colors. Accepts primary (required) plus ' +
  'optional secondary, accent, neutral, success, danger colors. Missing colors are ' +
  'auto-derived using color harmony rules. Returns WCAG AA-verified token overrides and CSS. ' +
  'Can optionally apply a preset base (glass, neumorphic, etc.) and set radius/font.',
  {
    primary: z.string().regex(/^#[0-9a-fA-F]{6}$/)
      .describe('Primary brand color as 6-digit hex (required)'),
    secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
      .describe('Secondary color (auto-derived from complementary if omitted)'),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
      .describe('Accent color (auto-derived from analogous if omitted)'),
    neutral: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
      .describe('Neutral/gray base color'),
    success: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
      .describe('Success color (default: #10b981)'),
    danger: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
      .describe('Danger/error color (default: #ef4444)'),
    preset: z.enum(['default', 'glass', 'neumorphic', 'brutalist', 'gradient', 'darkLuxury']).optional()
      .describe('Optional base preset to merge with'),
    radius: z.string().optional()
      .describe('Border radius override, e.g. "8px"'),
    font: z.string().optional()
      .describe('Font family override, e.g. "Inter, sans-serif"'),
  },
  async ({ primary, secondary, accent, neutral, success, danger, preset, radius, font }) => {
    try {
      const config = { primary };
      if (secondary) config.secondary = secondary;
      if (accent) config.accent = accent;
      if (neutral) config.neutral = neutral;
      if (success) config.success = success;
      if (danger) config.danger = danger;
      const options = {};
      if (preset) options.preset = preset;
      if (radius) options.radius = radius;
      if (font) options.font = font;
      if (Object.keys(options).length > 0) config.options = options;

      const overrides = deriveBrandTheme(config);
      const validation = validateTheme(overrides);
      const themeObj = createTheme(overrides);
      return safeResult({
        tokenOverrides: overrides,
        css: themeObj.toCSS(),
        tokenCount: Object.keys(overrides).length,
        validation: validation.summary,
        valid: validation.valid,
        failures: validation.failures,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 14: suggest_harmonies
// ============================================================================

server.tool(
  'suggest_harmonies',
  'Suggest color harmonies from a primary color. Returns 5 harmony types ' +
  '(complementary, analogous, split-complementary, triadic, tetradic), each with ' +
  'raw colors and WCAG AA-safe shades with contrast ratios on white.',
  {
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/)
      .describe('Primary color as 6-digit hex, e.g. "#2563eb"'),
  },
  async ({ color }) => {
    try {
      const harmonies = suggestHarmonies(color);
      return safeResult({
        sourceColor: color,
        harmonies,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 15: validate_theme
// ============================================================================

server.tool(
  'validate_theme',
  'Validate a set of theme overrides against WCAG AA contrast requirements. ' +
  'Checks 20 critical text/surface contrast pairs and returns pass/fail report. ' +
  'Use "audit" mode for detailed per-pair results.',
  {
    overrides: z.record(z.string(), z.string())
      .describe('Token overrides to validate, e.g. {"semantic.color.primary.default": "#2563eb"}'),
    audit: z.boolean().optional().default(false)
      .describe('If true, return detailed per-pair results (audit mode)'),
  },
  async ({ overrides, audit: auditMode }) => {
    try {
      if (auditMode) {
        const result = auditTheme(overrides);
        return safeResult(result);
      }
      const result = validateTheme(overrides);
      return safeResult(result);
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// TOOL 16: import_theme
// ============================================================================

server.tool(
  'import_theme',
  'Import a .aioli-theme.json file and generate complete theme overrides. ' +
  'The file must contain a name and brand.primary at minimum. Returns overrides, ' +
  'CSS, and WCAG validation results.',
  {
    themeFile: z.object({
      name: z.string().describe('Theme name'),
      brand: z.object({
        primary: z.string().describe('Primary hex color'),
        secondary: z.string().optional(),
        accent: z.string().optional(),
        neutral: z.string().optional(),
        success: z.string().optional(),
        danger: z.string().optional(),
      }).describe('Brand colors'),
      options: z.object({
        preset: z.string().optional(),
        radius: z.string().optional(),
        font: z.string().optional(),
      }).optional().describe('Theme options'),
      overrides: z.record(z.string(), z.string()).optional().describe('Manual overrides'),
    }).describe('Theme file content (JSON)'),
  },
  async ({ themeFile }) => {
    try {
      const result = importThemeFile(themeFile);
      return safeResult({
        name: result.metadata.name,
        tokenOverrides: result.overrides,
        css: result.theme.toCSS(),
        tokenCount: Object.keys(result.overrides).length,
        validation: result.validation.summary,
        valid: result.validation.valid,
      });
    } catch (e) {
      return errorResult(e);
    }
  }
);

// ============================================================================
// CONNECT
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Aioli MCP Server: Connected via stdio, 16 tools available');
}

main().catch((error) => {
  console.error('Aioli MCP Server: Fatal error:', error);
  process.exit(1);
});
