import { codeLines } from './code-lines.js';

/** Personal-data field names a reviewer recognises. */
export const PII_FIELD_NAMES = ['fullName', 'firstName', 'lastName', 'email', 'phone', 'phoneNumber', 'address', 'postalAddress', 'dateOfBirth', 'nationalId'];
/** A typed declaration of a personal-data field (an interface member or a zod schema key). */
export const PII_DECLARATION_PATTERN = `^\\s*(${PII_FIELD_NAMES.join('|')})\\??:\\s*(string|number|boolean|Date|z\\.)`;
/** JSX braces reading a personal-data field (`{person.email}`). */
export const PII_RENDER_PATTERN = `\\{[^}]*\\.(${PII_FIELD_NAMES.join('|')})\\b`;

const EXPORTED_PASCAL = /^export\s+(function|const)\s+[A-Z]\w*/;
const RETURNS_ELEMENT = /(return|=>)\s*\(?\s*<[A-Za-z]/;

/** Whether code lines starting at an exported PascalCase declaration return a JSX element within the next few lines. */
export function declaresComponent(lines: string[]): boolean {
  return lines.some((line, index) => EXPORTED_PASCAL.test(line) && RETURNS_ELEMENT.test(lines.slice(index, index + 4).join(' ')));
}

/** Whole-file judgement: a React component file (strings and comments ignored, so markup in a string is not JSX). */
export const isComponentSource = (text: string): boolean => declaresComponent(codeLines(text));

export function rendersPersonalData(text: string): boolean {
  return isComponentSource(text) && codeLines(text).some(line => new RegExp(PII_RENDER_PATTERN).test(line));
}

export function declaresPersonalData(text: string): boolean {
  return codeLines(text).some(line => new RegExp(PII_DECLARATION_PATTERN).test(line));
}
