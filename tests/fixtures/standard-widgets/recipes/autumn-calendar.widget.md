---
widget_schema: 1
template: calendar
template_version: 1
title: Autumn events
source:
  path: ../events/london-autumn-events.csv
  format: csv
time_zone: Europe/London
display_zone: Europe/London
mapping:
  id: id
  title: title
  start: start
  end: end
  zone: time_zone
  category: category
  detail: detail
views: [month, agenda, timeline]
initial:
  view: month
  period: 2026-10
  week_starts: monday
---
