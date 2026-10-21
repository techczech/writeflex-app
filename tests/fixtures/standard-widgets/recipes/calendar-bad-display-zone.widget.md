---
widget_schema: 1
template: calendar
template_version: 1
title: A valid event shown in a zone that does not exist
source:
  path: ../events/display-zone-invalid.csv
  format: csv
time_zone: UTC
display_zone: No/Such_Zone
mapping:
  id: id
  title: title
  start: start
  end: end
  zone: time_zone
views: [month]
---
