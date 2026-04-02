# Privacy Policy for DemoBuddy (Datadog Demo Buddy)

**Last Updated:** January 3, 2026

## Overview

DemoBuddy ("the Extension") is a Chrome browser extension designed to help users create and manage demonstration talk tracks for product demos. This privacy policy explains how the Extension collects, uses, and protects your information.

## Single Purpose

DemoBuddy's single purpose is to display presenter talk tracks for sales demonstrations based on the current browser URL, with AI-powered generation capabilities.

## Information We Collect

### Personally Identifiable Information
- **Email Address:** If you choose to create an account for cloud sync, we collect your email address for authentication purposes.

### Authentication Information
- **OpenAI API Key:** If you use AI features, your API key is stored locally in your browser's secure storage. It is transmitted only to OpenAI's API for authentication.
- **Authentication Tokens:** Session tokens for cloud sync are stored locally in your browser.

### Website Content
- **Screenshots:** When using AI generation, screenshots of the current browser tab are captured. These images are sent directly to OpenAI's API for analysis and are not stored by the Extension or our servers.

### Information You Provide
- **Talk Tracks:** Content you create within the Extension, including titles, notes, and URL patterns.
- **Customer Profiles:** Optional customer information you choose to store for demo personalization.
- **Custom Personas:** AI persona configurations you create.

### Information Processed Locally
- **Current Page URL:** The Extension reads the current page URL to match and display relevant talk tracks. URLs are processed locally and are not collected or stored as browsing history.

## How We Use Your Information

| Data Type | Purpose | Stored Where | Transmitted To |
|-----------|---------|--------------|----------------|
| Email address | Account authentication | Supabase (cloud) | Supabase |
| Talk tracks | Display demo notes | Local browser / Supabase (optional) | Supabase (if sync enabled) |
| Screenshots | AI talk track generation | Not stored | OpenAI API |
| OpenAI API key | AI feature authentication | Local browser only | OpenAI API |
| Current URL | Talk track matching | Memory only (not persisted) | None |

## Data Storage and Security

- **Local Data:** Stored in your browser using Chrome's secure storage APIs with encryption.
- **Cloud Data:** If you opt into cloud sync, data is stored in Supabase with encryption at rest and in transit.
- **API Keys:** Your OpenAI API key is stored locally and transmitted only to OpenAI for API authentication.
- **Automatic Backups:** Up to 50 local backup versions are stored in your browser for data recovery.

## Third-Party Services

The Extension integrates with the following third-party services:

| Service | Purpose | Data Shared | Their Privacy Policy |
|---------|---------|-------------|---------------------|
| **OpenAI** | AI talk track generation | Screenshots, prompts (using your API key) | [openai.com/privacy](https://openai.com/privacy) |
| **Supabase** | Cloud sync & authentication | Email, talk tracks (optional) | [supabase.com/privacy](https://supabase.com/privacy) |
| **GitHub Gists** | Optional backup sync | Talk track data (optional) | [docs.github.com/privacy](https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement) |

## Data Sharing and Transfer

**We do not sell your data.** User data is only transferred to third parties for the following approved purposes:

- **Service Providers:** To OpenAI, Supabase, or GitHub as described above, only when you explicitly use those features
- **Legal Requirements:** As required by applicable law

We do not:
- Sell or rent user data to third parties
- Use data for advertising or marketing purposes
- Transfer data for purposes unrelated to the Extension's single purpose
- Use data to determine creditworthiness or for lending purposes

## Your Rights and Controls

You have the right to:

| Right | How to Exercise |
|-------|-----------------|
| **Access** | View all stored data in the Extension's Options page |
| **Export** | Use the Export feature to download your talk tracks as JSON |
| **Delete Local Data** | Clear data from Options page or uninstall the Extension |
| **Delete Cloud Data** | Contact us to request deletion of cloud-synced data |
| **Opt-Out of Cloud Sync** | Simply don't create an account; all features work locally |
| **Opt-Out of AI Features** | Don't provide an OpenAI API key |

## Data Retention

- **Local Data:** Retained until you delete it or uninstall the Extension
- **Cloud Data:** Retained until you request deletion or delete your account
- **Screenshots:** Not retained; sent to OpenAI and immediately discarded
- **Backups:** Up to 50 versions retained locally; older backups automatically deleted

## Permissions Explained

| Permission | Why It's Needed |
|------------|-----------------|
| `storage`, `unlimitedStorage` | Store talk tracks, backups, and preferences locally |
| `activeTab` | Capture screenshots when you click "Capture & Generate" |
| `tabs` | Detect current tab URL for talk track matching; navigate during demo flows |
| `scripting` | Get page dimensions and scroll position for full-page screenshots |
| `tabCapture` | Capture visible tab screenshots for AI analysis |
| `offscreen` | Stitch multiple viewport screenshots into full-page images |
| `identity` | Enable Google OAuth sign-in for cloud sync |
| `host_permissions` (`<all_urls>`) | Detect URL changes on any website for talk track matching |

## Children's Privacy

The Extension is not intended for users under 13 years of age. We do not knowingly collect information from children under 13.

## Changes to This Policy

We may update this privacy policy periodically. The "Last Updated" date at the top indicates the most recent revision. Continued use of the Extension after changes constitutes acceptance of the updated policy.

## Contact Us

For questions about this privacy policy or to exercise your data rights, please contact:

- **Email:** steve.bresnick@datadoghq.com
- **GitHub:** https://github.com/pantheonsteve/DDDemoBuddy

## Consent

By installing and using DemoBuddy, you consent to the data practices described in this privacy policy.
