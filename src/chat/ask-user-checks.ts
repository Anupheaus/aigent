import type { Question } from './message.js';
import { validateAnswer } from './question-state.js';

/** One reason a question could not be answered as asked, with the path of the offending field under the question. */
export interface QuestionProblem {
  message: string;
  path: (string | number)[];
}

/** The question as the model wrote it (`default` still text). */
export type AskedQuestion = Omit<Question, 'default'> & { default?: string };

const BOUNDED_TYPES: ReadonlySet<string> = new Set(['text', 'number', 'multi_choice']);

function boundProblems(question: AskedQuestion): QuestionProblem[] {
  const { id, type, min, max, options = [] } = question;
  if (min == null && max == null) return [];
  if (!BOUNDED_TYPES.has(type)) return [{ message: `${type} question '${id}' takes no min or max`, path: [min == null ? 'max' : 'min'] }];
  if (min != null && max != null && min > max) return [{ message: `question '${id}' can never be answered: min ${min} is above max ${max}`, path: ['min'] }];
  if (type === 'multi_choice' && min != null && min > options.length) return [{ message: `multi_choice question '${id}' needs at least ${min} choices but has only ${options.length} options`, path: ['min'] }];
  return [];
}

/** Answers match an option by value or label, case-insensitively, and multi-choice text is split on commas. */
function optionProblems(question: AskedQuestion): QuestionProblem[] {
  const { id, type, options = [] } = question;
  const owners = new Map<string, number>();
  const problems: QuestionProblem[] = [];
  options.forEach(({ value, label }, index) => {
    if (type === 'multi_choice' && (value.includes(',') || label.includes(','))) problems.push({ message: `option '${value}' of question '${id}' contains a comma, which separates choices in a typed answer`, path: ['options', index] });
    for (const name of new Set([value.toLowerCase(), label.toLowerCase()])) {
      const owner = owners.get(name);
      if (owner != null && owner !== index) problems.push({ message: `option '${name}' of question '${id}' is ambiguous: it names two options`, path: ['options', index] });
      owners.set(name, index);
    }
  });
  return problems;
}

function defaultProblems(question: AskedQuestion): QuestionProblem[] {
  const { id, default: defaultText } = question;
  if (defaultText == null) return [];
  const check = validateAnswer({ question: { ...question, required: false }, value: defaultText });
  return check.ok ? [] : [{ message: `default of question '${id}' is invalid: ${check.error.replace(/^Answer to question '[^']*' \([a-z_]+\) is invalid: /, '')}`, path: ['default'] }];
}

/** Everything that would make a question unanswerable or ambiguous, so the model can fix and retry the call. */
export function questionProblems(question: AskedQuestion): QuestionProblem[] {
  const bounds = boundProblems(question);
  const options = optionProblems(question);
  // A default is only checked against a question that is otherwise sound (its checks rely on the bounds and options).
  return bounds.length > 0 || options.length > 0 ? [...bounds, ...options] : defaultProblems(question);
}
