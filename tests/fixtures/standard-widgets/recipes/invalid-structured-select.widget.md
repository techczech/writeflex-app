---
widget_schema: 1
template: browser
template_version: 1
title: Structured source with an impossible heading level
source:
  path: ../structured-text/process-catalogue.md
  format: structured-markdown
  select:
    level: 9
mapping:
  title: heading
  detail: body
views: [browser]
---
