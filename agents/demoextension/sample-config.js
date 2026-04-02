/**
 * Sample Talk Tracks Configuration
 * 
 * To use this:
 * 1. Open the extension's options page
 * 2. Open Chrome DevTools (F12)
 * 3. Go to Console tab
 * 4. Copy and paste this entire file
 * 5. Press Enter
 * 6. Reload the options page
 */

const sampleTalkTracks = [
  {
    id: Date.now(),
    urlPattern: '*/dashboards/*',
    content: `Dashboard Overview

Key points to cover:
• Real-time metrics from production environment
• Time selector in top right (currently last 4 hours)
• Each widget is customizable

Main sections:
1. Infrastructure health (top row)
2. Application performance (middle)
3. Business KPIs (bottom)

Transition: "Let's dive into the infrastructure section first..."`
  },
  {
    id: Date.now() + 1,
    urlPattern: '*/apm/services*',
    content: `APM Services Overview

This monitors all our microservices:
• 50+ services in production
• Average response time: ~200ms
• 15M requests per day

Key services to highlight:
- web-frontend (user traffic)
- api-gateway (routing)
- payment-service (critical)

⚠️ Red = degradation
⚠️ Yellow = warning threshold

Transition: "Click any service to see detailed traces..."`
  },
  {
    id: Date.now() + 2,
    urlPattern: '*/infrastructure*',
    content: `Infrastructure Monitoring

Current view:
• Real-time hosts and containers
• 200+ hosts across 3 availability zones
• Color coding: green, yellow, red

Features to demo:
1. Overall cluster health
2. Zoom into availability zone
3. Click host for detailed metrics
4. Filter by tags (env:prod, team:platform)

Key metric: "Average CPU is 45% - good headroom"`
  },
  {
    id: Date.now() + 3,
    urlPattern: '*/monitors*',
    content: `Alert Configuration

Overview:
• 150+ active monitors
• Infrastructure, apps, and business metrics
• PagerDuty, Slack, email integration

Monitor types:
✓ Metric (threshold-based)
✓ APM (latency, errors)
✓ Log (error patterns)
✓ Composite (complex conditions)

Best practices:
1. Every monitor has owner
2. Clear escalation paths
3. Runbook links
4. Regular alert fatigue reviews`
  },
  {
    id: Date.now() + 4,
    urlPattern: '*/logs*',
    content: `Log Management

Current stats:
• Last 15 minutes of production logs
• ~1M log lines per minute
• Indexed and searchable in real-time

Key features:
1. Search syntax (boolean, wildcards)
2. Facets (quick filtering)
3. Patterns (auto clustering)
4. Analytics (aggregate metrics)

Example query:
status:error service:payment-service

Pro tip: Save frequently used queries!`
  }
];

// Save to Chrome storage
chrome.storage.local.set({ talkTracks: sampleTalkTracks }, () => {
  console.log('✅ Sample talk tracks loaded!');
  console.log('Reload the options page to see them.');
  console.log(`Added ${sampleTalkTracks.length} talk tracks.`);
});
