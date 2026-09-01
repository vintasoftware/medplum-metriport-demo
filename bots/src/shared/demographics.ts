// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { Patient } from '@medplum/fhirtypes';

/**
 * Maps a Medplum Patient to the demographics Metriport matches on.
 *
 * This only maps: it does not validate. Metriport's request schema is the source of truth, and it
 * reports failures precisely, naming the field path, so a local copy of those rules would only
 * drift and risk rejecting patients Metriport would accept.
 *
 * Fields the patient does not have are left out, and `JSON.stringify` drops them, so Metriport
 * decides what is required.
 *
 * https://docs.metriport.com/medical-api/api-reference/patient/match-patient
 */

export type GenderAtBirth = 'M' | 'F' | 'O' | 'U';

export interface MetriportAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country: 'USA';
}

export interface MetriportDemographics {
  firstName?: string;
  lastName?: string;
  dob?: string;
  genderAtBirth?: GenderAtBirth;
  address?: [MetriportAddress];
  contact?: [{ phone?: string; email?: string }];
}

const GENDER_AT_BIRTH: Record<string, GenderAtBirth> = {
  male: 'M',
  female: 'F',
  other: 'O',
  unknown: 'U',
};

const ZIP_LENGTH = 5;

/**
 * @param patient - The Medplum Patient.
 * @returns The demographics to send to Metriport.
 */
export function buildDemographics(patient: Patient): MetriportDemographics {
  const name = patient.name?.[0];
  const address = patient.address?.[0];
  const contact = buildContact(patient);

  return {
    firstName: trimmed(name?.given?.[0]),
    lastName: trimmed(name?.family),
    dob: patient.birthDate,
    // Metriport uses single letters, Medplum uses FHIR administrative-gender.
    genderAtBirth: patient.gender ? GENDER_AT_BIRTH[patient.gender] : undefined,
    ...(address && {
      address: [
        {
          addressLine1: trimmed(address.line?.[0]),
          addressLine2: trimmed(address.line?.[1]),
          city: trimmed(address.city),
          state: trimmed(address.state)?.toUpperCase(),
          // Metriport strips punctuation then requires exactly 5 digits, so a ZIP+4 has to be cut
          // down here or an otherwise valid address is rejected.
          zip: toZip(address.postalCode),
          country: 'USA',
        },
      ],
    }),
    ...(contact && { contact }),
  };
}

/**
 * Contact is optional to Metriport, but an entry holding neither a phone nor an email is rejected.
 *
 * @param patient - The Medplum Patient.
 * @returns The contact entry, or undefined when the patient has neither value.
 */
function buildContact(patient: Patient): MetriportDemographics['contact'] {
  const phone = trimmed(patient.telecom?.find((t) => t.system === 'phone')?.value);
  const email = trimmed(patient.telecom?.find((t) => t.system === 'email')?.value);

  if (!phone && !email) {
    return undefined;
  }

  return [{ ...(phone && { phone }), ...(email && { email }) }];
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * @param postalCode - The Medplum address postal code.
 * @returns The leading five digits, or undefined when there are fewer.
 */
function toZip(postalCode: string | undefined): string | undefined {
  const digits = postalCode?.replace(/\D/g, '');
  return digits && digits.length >= ZIP_LENGTH ? digits.slice(0, ZIP_LENGTH) : undefined;
}
