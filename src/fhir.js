'use strict';
// FHIR R4 builders and a structural validator for the resources this SHR exchanges.
// NOTE: identifier system URLs are placeholders for local use; swap in the official
// PhilSys / NHFR / NHWR systems (and PH Core profiles) when you have them.
const crypto = require('node:crypto');

const SYS = {
  philsys: 'https://example.org/identifier/philsys-pcn',
  nhfr: 'https://example.org/identifier/nhfr-code',
  nhwr: 'https://example.org/identifier/nhwr-id',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  loinc: 'http://loinc.org',
  rolecode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
};

const uuid = () => crypto.randomUUID();
const digits = (s) => String(s).replace(/\D/g, '');

const ids = {
  patient: (philsys) => 'pt-' + digits(philsys),
  org: (nhfr) => 'org-' + String(nhfr).toLowerCase(),
  prac: (nhwr) => 'prac-' + String(nhwr).toLowerCase(),
  task: (srId) => 'task-' + srId,
};

const ref = (type, id, display) => ({ reference: `${type}/${id}`, ...(display ? { display } : {}) });
const entry = (resource) => ({
  fullUrl: `urn:uuid:${resource.id}`,
  resource,
  request: { method: 'PUT', url: `${resource.resourceType}/${resource.id}` },
});

// --- base resources from registry rows -------------------------------------
function patientResource(p) {
  return {
    resourceType: 'Patient', id: ids.patient(p.philsys_id), active: p.active,
    identifier: [{ system: SYS.philsys, value: p.philsys_id }],
    name: [{ use: 'official', family: p.family_name, given: [p.given_name] }],
    gender: p.gender, birthDate: p.birth_date,
  };
}
function organizationResource(f) {
  return {
    resourceType: 'Organization', id: ids.org(f.nhfr_code), active: f.active,
    identifier: [{ system: SYS.nhfr, value: f.nhfr_code }],
    name: f.name, type: [{ text: f.fac_type }],
  };
}
function practitionerResource(w) {
  return {
    resourceType: 'Practitioner', id: ids.prac(w.nhwr_id), active: w.active,
    identifier: [{ system: SYS.nhwr, value: w.nhwr_id }],
    name: [{ family: w.family_name, given: [w.given_name] }],
    qualification: [{ code: { text: w.role } }],
  };
}

// --- clinical content -------------------------------------------------------
function clinicalEntries({ patient, encounterId, conditions = [], observations = [], medications = [], medKind }) {
  const out = [];
  const subject = ref('Patient', patient.id);
  const encounter = ref('Encounter', encounterId);
  conditions.forEach((c) => out.push({
    resourceType: 'Condition', id: uuid(),
    clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
    code: { coding: c.code ? [{ system: SYS.icd10, code: c.code, display: c.display }] : undefined, text: c.display },
    subject, encounter,
  }));
  observations.forEach((o) => out.push({
    resourceType: 'Observation', id: uuid(), status: 'final',
    code: { coding: o.code ? [{ system: SYS.loinc, code: o.code, display: o.display }] : undefined, text: o.display },
    subject, encounter,
    ...(o.value !== undefined && o.value !== '' && !isNaN(Number(o.value))
      ? { valueQuantity: { value: Number(o.value), unit: o.unit || '' } }
      : { valueString: String(o.value ?? '') }),
  }));
  medications.forEach((m) => out.push(
    medKind === 'request'
      ? { resourceType: 'MedicationRequest', id: uuid(), status: 'active', intent: 'order',
          medicationCodeableConcept: { text: m.display }, subject, encounter,
          dosageInstruction: m.dosage ? [{ text: m.dosage }] : undefined }
      : { resourceType: 'MedicationStatement', id: uuid(), status: 'active',
          medicationCodeableConcept: { text: m.display }, subject,
          dosage: m.dosage ? [{ text: m.dosage }] : undefined }
  ));
  return out;
}

function encounterResource({ id, patient, org, practitioner, reason }) {
  return {
    resourceType: 'Encounter', id, status: 'finished',
    class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
    subject: ref('Patient', patient.id),
    participant: [{ individual: ref('Practitioner', practitioner.id) }],
    serviceProvider: ref('Organization', org.id),
    reasonCode: reason ? [{ text: reason }] : undefined,
    period: { start: new Date().toISOString(), end: new Date().toISOString() },
  };
}

// --- referral bundle --------------------------------------------------------
function buildReferralBundle({ patientRow, fromFac, toFac, worker, input }) {
  const patient = patientResource(patientRow);
  const fromOrg = organizationResource(fromFac);
  const toOrg = organizationResource(toFac);
  const prac = practitionerResource(worker);
  const encId = uuid(), srId = uuid();

  const encounter = encounterResource({ id: encId, patient, org: fromOrg, practitioner: prac, reason: input.reason });
  const clinical = clinicalEntries({
    patient, encounterId: encId,
    conditions: input.conditions, observations: input.observations, medications: input.medications,
    medKind: 'statement',
  });

  const serviceRequest = {
    resourceType: 'ServiceRequest', id: srId, status: 'active', intent: 'order',
    priority: ['routine', 'urgent', 'asap', 'stat'].includes(input.priority) ? input.priority : 'routine',
    category: [{ text: 'Referral' }],
    code: { text: input.service || 'Specialist referral' },
    subject: ref('Patient', patient.id),
    encounter: ref('Encounter', encId),
    authoredOn: new Date().toISOString(),
    requester: ref('Practitioner', prac.id),
    performer: [ref('Organization', toOrg.id)],
    reasonCode: [{ text: input.reason }],
    note: input.note ? [{ text: input.note }] : undefined,
    supportingInfo: clinical.filter((r) => r.resourceType === 'Condition').map((c) => ref('Condition', c.id)),
  };
  const task = {
    resourceType: 'Task', id: ids.task(srId), status: 'requested', intent: 'order',
    code: { text: 'referral' },
    focus: ref('ServiceRequest', srId), for: ref('Patient', patient.id),
    authoredOn: serviceRequest.authoredOn,
    requester: ref('Organization', fromOrg.id), owner: ref('Organization', toOrg.id),
  };

  const resources = [patient, fromOrg, toOrg, prac, encounter, ...clinical, serviceRequest, task];
  return { bundle: toBundle(resources), serviceRequestId: srId };
}

// --- back-referral bundle ---------------------------------------------------
function buildBackReferralBundle({ patientRow, fromFac, toFac, worker, input, serviceRequest, task }) {
  const patient = patientResource(patientRow);
  const fromOrg = organizationResource(fromFac);   // the hospital sending back
  const toOrg = organizationResource(toFac);       // the originating facility
  const prac = practitionerResource(worker);
  const encId = uuid();

  const encounter = encounterResource({ id: encId, patient, org: fromOrg, practitioner: prac, reason: input.findings });
  const clinical = clinicalEntries({
    patient, encounterId: encId,
    conditions: input.conditions, observations: input.observations, medications: input.medications,
    medKind: 'request',
  });
  const communication = {
    resourceType: 'Communication', id: uuid(), status: 'completed',
    category: [{ text: 'back-referral' }],
    subject: ref('Patient', patient.id),
    about: [ref('ServiceRequest', serviceRequest.id)],
    sender: ref('Practitioner', prac.id), recipient: [ref('Organization', toOrg.id)],
    sent: new Date().toISOString(),
    payload: [{ contentString: input.findings }, ...(input.followUp ? [{ contentString: 'Follow-up: ' + input.followUp }] : [])],
  };
  // Same ids => the SHR stores these as new versions of the original referral
  const closedSr = { ...serviceRequest, status: 'completed' };
  const closedTask = {
    ...task, status: 'completed',
    output: [{ type: { text: 'back-referral' }, valueReference: ref('Communication', communication.id) }],
  };
  delete closedSr.meta; delete closedTask.meta;

  const resources = [patient, fromOrg, toOrg, prac, encounter, ...clinical, communication, closedSr, closedTask];
  return { bundle: toBundle(resources) };
}

function toBundle(resources) {
  return { resourceType: 'Bundle', id: uuid(), type: 'transaction', timestamp: new Date().toISOString(), entry: resources.map(entry) };
}

// --- structural validator ---------------------------------------------------
const REQUIRED = {
  Patient: ['identifier', 'name', 'gender', 'birthDate'],
  Organization: ['identifier', 'name'],
  Practitioner: ['identifier', 'name'],
  Encounter: ['status', 'class', 'subject'],
  Condition: ['code', 'subject'],
  Observation: ['status', 'code', 'subject'],
  MedicationStatement: ['status', 'medicationCodeableConcept', 'subject'],
  MedicationRequest: ['status', 'intent', 'medicationCodeableConcept', 'subject'],
  ServiceRequest: ['status', 'intent', 'subject'],
  Task: ['status', 'intent'],
  Communication: ['status', 'subject'],
};
const VALUE_SETS = {
  ServiceRequest: { status: ['draft', 'active', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'], intent: ['proposal', 'plan', 'directive', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'] },
  Task: { status: ['draft', 'requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled', 'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'] },
  Observation: { status: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'] },
  Patient: { gender: ['male', 'female', 'other', 'unknown'] },
};

function collectRefs(node, acc = []) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, acc));
  else if (node && typeof node === 'object') {
    if (typeof node.reference === 'string') acc.push(node.reference);
    Object.values(node).forEach((v) => collectRefs(v, acc));
  }
  return acc;
}

// existsInDb(type,id) -> Promise<boolean>; returns { valid, errors[] }
async function validateBundle(bundle, existsInDb) {
  const errors = [];
  if (!bundle || bundle.resourceType !== 'Bundle') return { valid: false, errors: ['Not a Bundle'] };
  if (!['transaction', 'collection', 'batch'].includes(bundle.type)) errors.push('Bundle.type must be transaction/collection/batch');
  if (!Array.isArray(bundle.entry) || !bundle.entry.length) errors.push('Bundle.entry is empty');
  const inBundle = new Set();
  for (const e of bundle.entry || []) {
    const r = e.resource;
    if (!r || !r.resourceType || !r.id) { errors.push('Entry without resourceType/id'); continue; }
    inBundle.add(`${r.resourceType}/${r.id}`);
    const need = REQUIRED[r.resourceType];
    if (!need) { errors.push(`${r.resourceType}: resource type not supported by this SHR`); continue; }
    for (const f of need) {
      const v = r[f];
      if (v === undefined || v === null || (Array.isArray(v) && !v.length)) errors.push(`${r.resourceType}/${r.id}: missing required element "${f}"`);
    }
    const vs = VALUE_SETS[r.resourceType] || {};
    for (const [k, allowed] of Object.entries(vs)) {
      if (r[k] !== undefined && !allowed.includes(r[k])) errors.push(`${r.resourceType}/${r.id}: ${k} "${r[k]}" is not a valid code`);
    }
  }
  for (const e of bundle.entry || []) {
    for (const rf of collectRefs(e.resource)) {
      if (!/^[A-Za-z]+\/[A-Za-z0-9\-.]+$/.test(rf)) continue;
      if (inBundle.has(rf)) continue;
      const [t, i] = rf.split('/');
      if (!(await existsInDb(t, i))) errors.push(`${e.resource.resourceType}/${e.resource.id}: unresolved reference ${rf}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

module.exports = { SYS, ids, buildReferralBundle, buildBackReferralBundle, validateBundle };
