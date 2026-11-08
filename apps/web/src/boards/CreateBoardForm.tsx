import { useState, type FormEvent } from 'react';
import { boardTitleSchema } from '@inkroom/shared';
import { describeError } from '../auth/messages';
import { TextField } from '../components/TextField';

interface CreateBoardFormProps {
  onCreate: (title: string) => Promise<void>;
}

export function CreateBoardForm({ onCreate }: CreateBoardFormProps) {
  const [title, setTitle] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = boardTitleSchema.safeParse(title);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message);
      setFormError(null);
      return;
    }

    setFieldError(undefined);
    setFormError(null);
    setSubmitting(true);
    try {
      await onCreate(parsed.data);
      setTitle('');
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate aria-label="Create board" className="inline-form">
      <TextField
        id="new-board-title"
        label="New board name"
        name="title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={fieldError}
        disabled={submitting}
      />
      <button type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create board'}
      </button>
      {formError && (
        <p role="alert" className="form-error">
          {formError}
        </p>
      )}
    </form>
  );
}
