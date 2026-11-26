# Versioned Schema Storage

This directory contains versioned schemas for PDF forms.

## Structure

```
schemas/
└── v1/
    ├── layout.json
    ├── mapping.json
    └── transforms.json
```

## Why Versioned Storage?

1. **Forms change**: PDF templates get updated periodically
2. **Carriers modify PDFs**: Different carriers may have slightly different versions
3. **Rollback capability**: You can revert to a previous schema if needed
4. **Audit trail**: Track changes over time

## Schema Files

### layout.json
Contains field coordinates, sizes, types, and rendering properties.

```json
{
  "applicantName": {
    "page": 0,
    "x": 118,
    "y": 712,
    "width": 260,
    "height": 14,
    "type": "text",
    "fontSize": 10,
    "maxWidth": 260
  }
}
```

### mapping.json
Maps canonical semantic keys to physical PDF fields.

```json
{
  "artifactType": "field-mapping",
  "version": "1.0",
  "mappings": [
    {
      "id": "mapping_001",
      "semanticKey": "applicant.name",
      "binding": { "fieldId": "field_001", "sourceId": "applicantName" }
    }
  ]
}
```

### transforms.json
Defines field-level formatters.

```json
{
  "effectiveDate": {
    "type": "date",
    "format": "MM/DD/YYYY"
  },
  "premium": {
    "type": "currency"
  }
}
```

## Usage

Load schemas into the form registry:

```typescript
import { formRegistry } from '@lomi/pdf';

const schema = {
  layout: require('./schemas/v1/layout.json'),
  mapping: require('./schemas/v1/mapping.json'),
  transforms: require('./schemas/v1/transforms.json'),
};

await formRegistry.loadFromFiles('generic-form', 'Generic Form', 'v1', schema);
```

## Best Practices

1. **Never modify existing versions**: Create a new version (v2) instead
2. **Document changes**: Add a CHANGELOG.md in each version directory
3. **Test before deploying**: Use regression tests to validate new versions
4. **Keep templates synchronized**: Store PDF templates alongside schemas
