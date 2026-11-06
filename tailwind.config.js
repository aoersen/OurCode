/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Glass 2026 design tokens (mapped to CSS variables in global.css)
        nova: {
          bg: 'var(--bg, #f6f7fb)',
          surface: 'var(--surface, #ffffff)',
          card: 'var(--card, rgba(255,255,255,0.75))',
          sidebar: 'var(--sidebar, #ffffff)',
          editor: 'var(--editor-bg, #ffffff)',
          'code-bg': 'var(--surface, #ffffff)',
          terminal: '#0f1420',
          'ai-panel': 'var(--ai-bg, #ffffff)',
          'ai-header': 'var(--ai-surface, rgba(255,255,255,0.6))',
          tabs: 'var(--bg-tabs, rgba(255,255,255,0.6))',
          'tab-active': 'var(--bg-tab-active, #ffffff)',
          border: 'var(--border, rgba(15,23,42,0.08))',
          'border-light': 'rgba(255,255,255,0.6)',
          'border-dark': 'var(--ai-border, rgba(15,23,42,0.1))',
          hover: 'var(--hover, rgba(15,23,42,0.06))',
          'input-bg': 'var(--input-bg, rgba(255,255,255,0.6))',
          'bubble-user': 'var(--bubble-user, #e8f0ff)',
          'bubble-ai': 'var(--ai-surface, rgba(255,255,255,0.6))',
          'badge-bg': 'rgba(0,88,188,0.1)',
          'text-primary': 'var(--text-primary, #0f172a)',
          'text-secondary': 'var(--text-secondary, #334155)',
          'text-muted': 'var(--text-muted, #64748b)',
          accent: 'var(--accent, #0058bc)',
          'accent-text': 'var(--accent-text, var(--accent, #0058bc))',
          'accent-ink': 'var(--accent-ink, #ffffff)',
        },
        accent: {
          blue: 'var(--accent, #0058bc)',
          purple: 'var(--accent-purple, #7c3aed)',
          'btn-primary': 'var(--accent, #0058bc)',
          'btn-send': 'var(--accent, #0058bc)',
        },
        // Stitch Glass Light tokens — glassmorphism surfaces & hairline borders
        glass: {
          border: 'rgba(255,255,255,0.6)',
          bg: 'rgba(255,255,255,0.4)',
        },
        // Status colors (Stitch design palette, theme-aware via CSS variables)
        warning: 'var(--warning, #d97706)',
        success: 'var(--success, #16a34a)',
        error: 'var(--error, #dc2626)',
        // Text-safe status colors (≥4.5:1 at 11–12px on pale tints and on the
        // app background). Use `text-warning-text` etc. for TEXT; keep the vivid
        // `--warning/--success/--error` for rings, dots and borders (3:1).
        'warning-text': 'var(--warning-text, #b45309)',
        'success-text': 'var(--success-text, #047857)',
        'error-text': 'var(--error-text, #b91c1c)',
        'error-container': 'var(--error-container, #fee2e2)',
        'primary-container': 'var(--primary-container, #e8f0ff)',
        // Translucent status/primary tints — literal color-mix values so
        // Tailwind's JIT can emit them (var()+alpha modifiers are not emitted)
        'warning-10': 'color-mix(in srgb, var(--warning, #d97706) 10%, transparent)',
        'warning-30': 'color-mix(in srgb, var(--warning, #d97706) 30%, transparent)',
        'warning-5': 'color-mix(in srgb, var(--warning, #d97706) 5%, transparent)',
        'warning-90': 'color-mix(in srgb, var(--warning, #d97706) 90%, transparent)',
        'error-10': 'color-mix(in srgb, var(--error, #dc2626) 10%, transparent)',
        'error-20': 'color-mix(in srgb, var(--error, #dc2626) 20%, transparent)',
        'success-10': 'color-mix(in srgb, var(--success, #16a34a) 10%, transparent)',
        'success-20': 'color-mix(in srgb, var(--success, #16a34a) 20%, transparent)',
        'accent-10': 'color-mix(in srgb, var(--accent, #0058bc) 10%, transparent)',
        'accent-15': 'color-mix(in srgb, var(--accent, #0058bc) 15%, transparent)',
        'accent-20': 'color-mix(in srgb, var(--accent, #0058bc) 20%, transparent)',
        'accent-30': 'color-mix(in srgb, var(--accent, #0058bc) 30%, transparent)',
        'accent-40': 'color-mix(in srgb, var(--accent, #0058bc) 40%, transparent)',
        'accent-50': 'color-mix(in srgb, var(--accent, #0058bc) 50%, transparent)',
        'accent-60': 'color-mix(in srgb, var(--accent, #0058bc) 60%, transparent)',
        'accent-80': 'color-mix(in srgb, var(--accent, #0058bc) 80%, transparent)',
        'accent-5': 'color-mix(in srgb, var(--accent, #0058bc) 5%, transparent)',
        text: {
          primary: 'var(--text-primary, #0f172a)',
          secondary: 'var(--text-secondary, #334155)',
          muted: 'var(--text-muted, #64748b)',
          dim: 'var(--text-disabled, #cbd5e1)',
        },
        syntax: {
          keyword: '#C184C6',
          function: '#D1D6AE',
          string: '#C48081',
          comment: '#6F9B60',
          default: '#BBBEBF',
          line: '#5C6370',
        },
        // Keep legacy for compatibility
        editor: {
          bg: '#0f1420',
          'bg-light': '#ffffff',
          fg: '#BBBEBF',
          'fg-light': '#202020',
          line: '#0f1420',
          'line-light': '#f8fafc',
          selection: '#276782',
          'selection-light': '#0058bc',
          comment: '#6F9B60',
          keyword: '#C184C6',
          string: '#C48081',
        },
        sidebar: {
          bg: '#151a26',
          'bg-light': '#ffffff',
          hover: '#1b2130',
          'hover-light': 'rgba(15,23,42,0.06)',
        },
        chat: {
          bg: '#151a26',
          'bg-light': '#ffffff',
          user: '#0058bc',
          assistant: '#0058bc',
          input: '#1b2130',
          'input-light': 'rgba(255,255,255,0.6)',
        },
      },
      backgroundImage: {
        'gradient-blue-violet': 'linear-gradient(135deg, #0ea5e9, #6366f1, #a855f7)',
        'gradient-sunset-peach': 'linear-gradient(135deg, #f97316, #fb7185)',
      },
      fontFamily: {
        sans: ['Plus Jakarta Sans', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'monospace'],
      },
      animation: {
        'slide-in': 'slideIn 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'pulse-dot': 'pulseDot 1.5s infinite',
        'logo-pulse': 'logoPulse 2.5s ease-in-out infinite',
        'think-bounce': 'thinkBounce 1.2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
        'pulse-soft': 'pulseSoft 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulseDot: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' },
        },
        logoPulse: {
          '0%, 100%': { boxShadow: '0 0 6px #0058bc88' },
          '50%': { boxShadow: '0 0 14px #0ea5e9, 0 0 24px #0ea5e966' },
        },
        thinkBounce: {
          '0%, 80%, 100%': { transform: 'translateY(0)' },
          '40%': { transform: 'translateY(-6px)', opacity: '0.6' },
        },
      },
    },
  },
  plugins: [],
}
