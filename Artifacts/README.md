# Multi-Language (i18n), RTL & Farsi Support — Review & Master Plan

This folder (`Artifacts/`) contains the complete architectural review, audit findings, technical design, and step-by-step implementation plan for making **Gr8r Studio** (`simpleprojman`) multi-language with first-class support for **Farsi (Persian / `fa-IR`)** and **Right-to-Left (RTL)** layouts.

## Contents

1. **[01 — Codebase Review & Audit](./01-codebase-review-and-audit.md)**
   - Architectural strengths of Gr8r Studio's synchronous full-DOM render loop (`render()`).
   - File-by-file audit of current i18n, RTL, date/time, numeral, and keyboard bottlenecks.
2. **[02 — Technical Architecture & Farsi/RTL Design](./02-architecture-and-farsi-rtl-design.md)**
   - Zero-dependency i18n core (`src/core/i18n.js`) & reactive vocabulary getters.
   - CSS Logical Properties migration & RTL animation variables (`--dir`).
   - Bidirectional (`dir="auto"` / `dir="ltr"`) text isolation strategy.
   - Farsi typography (`Vazirmatn`), Eastern Arabic/Persian numerals (`۰-۹`), and Solar Hijri (Jalali) calendar architecture.
   - Layout-independent keyboard shortcuts (`KeyboardEvent.code`) for Persian OS keyboard layouts.
3. **[03 — Phased Implementation Plan & Step-by-Step Checklist](./03-implementation-plan-and-steps.md)**
   - 5-phase execution plan with concrete code blueprints, file modification lists, and verification criteria.
