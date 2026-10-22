(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SHRPatientPrefill = factory();
})(globalThis, function () {
'use strict';

const text = (value) => String(value ?? '').replace(/[|\r\n]+/g, ' ').trim();

function conceptDisplay(concept) {
  const coding = concept?.coding?.find((item) => item.display || item.code);
  return text(concept?.text || coding?.display || coding?.code);
}

function systemCode(coding, systemPattern) {
  return coding?.system && systemPattern.test(coding.system) ? text(coding.code) : '';
}

function entriesOf(bundle) {
  if (bundle?.resourceType !== 'Bundle' || !Array.isArray(bundle.entry)) {
    throw new Error('Expected a FHIR Bundle from the SHR patient record API.');
  }
  return bundle.entry.map((entry) => entry.resource).filter(Boolean);
}

function prefillFromBundle(bundle) {
  const resources = entriesOf(bundle);
  const conditions = resources
    .filter((resource) => resource.resourceType === 'Condition')
    .filter((resource) => !resource.clinicalStatus?.coding?.length
      || resource.clinicalStatus.coding.some((coding) => coding.code === 'active'))
    .map((resource) => {
      const coding = resource.code?.coding?.find((item) => item.code);
      const display = conceptDisplay(resource.code);
      return [systemCode(coding, /icd-10/i), display].filter(Boolean).join(' | ');
    })
    .filter(Boolean);

  const latestObservations = new Map();
  for (const resource of resources) {
    if (resource.resourceType !== 'Observation' || resource.status === 'entered-in-error') continue;
    const coding = resource.code?.coding?.find((item) => item.code);
    const code = systemCode(coding, /loinc/i);
    const key = code || conceptDisplay(resource.code) || resource.id;
    const date = Date.parse(resource.effectiveDateTime || resource.issued || resource.meta?.lastUpdated || '') || 0;
    const current = latestObservations.get(key);
    if (!current || date >= current.date) latestObservations.set(key, { resource, coding, date });
  }
  const observations = [...latestObservations.values()].map(({ resource, coding }) => {
    const display = text(resource.code?.text || coding?.display || coding?.code);
    const code = systemCode(coding, /loinc/i);
    let value = '';
    let unit = '';
    if (resource.valueQuantity) {
      value = text(resource.valueQuantity.value);
      unit = text(resource.valueQuantity.unit || resource.valueQuantity.code);
    } else if (resource.valueString !== undefined) {
      value = text(resource.valueString);
    } else {
      value = conceptDisplay(resource.valueCodeableConcept);
    }
    return [code, display, value, unit].filter(Boolean).join(' | ');
  }).filter(Boolean);

  const medicationMap = new Map();
  for (const resource of resources) {
    if (!['MedicationStatement', 'MedicationRequest'].includes(resource.resourceType)) continue;
    if (resource.status && !['active', 'intended', 'on-hold'].includes(resource.status)) continue;
    const medication = conceptDisplay(resource.medicationCodeableConcept) || text(resource.medicationReference?.display);
    if (!medication) continue;
    const dosage = resource.dosageInstruction?.map((item) => item.text).filter(Boolean).join('; ')
      || resource.dosage?.map((item) => item.text).filter(Boolean).join('; ')
      || '';
    medicationMap.set(`${medication.toLowerCase()}|${dosage.toLowerCase()}`, [medication, text(dosage)].filter(Boolean).join(' | '));
  }

  const latestUpdate = resources.reduce((latest, resource) => {
    const date = Date.parse(resource.meta?.lastUpdated || '') || 0;
    return date > latest ? date : latest;
  }, 0);

  return {
    conditions: conditions.join('\n'),
    observations: observations.join('\n'),
    medications: [...medicationMap.values()].join('\n'),
    updatedAt: latestUpdate ? new Date(latestUpdate).toISOString() : null,
    counts: {
      conditions: conditions.length,
      observations: observations.length,
      medications: medicationMap.size,
    },
  };
}

return { prefillFromBundle };
});
