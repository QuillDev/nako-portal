"use client";

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { InputGroup, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { editDraft, remainingAttachments, submittedDraftIsCurrent, type Draft } from "@/lib/draft-state";
import { holdReload } from "@/lib/reload-state";
import { cn } from "@/lib/utils";
import { attachmentDataUrl, validateAttachments, type AttachmentFile, type AttachmentLimits } from "@/lib/attachments";
import { CornerDownLeftIcon, Loader2Icon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { id } from "@/lib/id";
import {
  type ChangeEvent, type ChangeEventHandler, Children, type ClipboardEventHandler,
  type ComponentProps, createContext, type FormEvent, type FormEventHandler, Fragment,
  type HTMLAttributes, type KeyboardEventHandler, type PropsWithChildren, type ReactNode,
  useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";

type FileUIPart = AttachmentFile;
type ChatStatus = "submitted" | "streaming" | "ready" | "error";
type AttachedFile = AttachmentFile & { id: string; file: File };
type AttachmentsContext = ReturnType<typeof useAttachmentController>;
type TextInputContext = { value: string; setInput: (value: string) => void; snapshot: () => Draft; clearSubmitted: (submitted: Draft) => boolean };
type PromptInputControllerProps = { textInput: TextInputContext; attachments: AttachmentsContext };
const PromptInputController = createContext<PromptInputControllerProps | null>(null);
const AttachmentsContext = createContext<AttachmentsContext | null>(null);
const useOptionalPromptInputController = () => useContext(PromptInputController);

export const usePromptInputController = () => {
  const controller = useOptionalPromptInputController();
  if (!controller) throw new Error("Wrap your component inside <PromptInputProvider>.");
  return controller;
};

export const usePromptInputAttachments = () => {
  const attachments = useContext(AttachmentsContext);
  if (!attachments) throw new Error("Attachments require PromptInput or PromptInputProvider.");
  return attachments;
};

/** One controller owns validation, original files, and object URLs in either mode. */
function useAttachmentController() {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const current = useRef(files);
  const limits = useRef<AttachmentLimits>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const configure = useCallback((next: AttachmentLimits) => { limits.current = next; }, []);
  const add = useCallback((incoming: File[] | FileList) => {
    const accepted = validateAttachments(Array.from(incoming), current.current.length, limits.current);
    if (!accepted.length) return;
    const added = accepted.map(file => ({
      id: id(), type: "file" as const, file, url: URL.createObjectURL(file),
      mediaType: file.type, filename: file.name,
    }));
    current.current = [...current.current, ...added];
    setFiles(current.current);
  }, []);
  const remove = useCallback((id: string) => {
    const removed = current.current.find(file => file.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    current.current = remainingAttachments(current.current, [{ id }]);
    setFiles(current.current);
  }, []);
  const clear = useCallback(() => {
    for (const file of current.current) URL.revokeObjectURL(file.url);
    current.current = [];
    setFiles([]);
  }, []);
  const openFileDialog = useCallback(() => fileInputRef.current?.click(), []);
  useEffect(() => () => {
    for (const file of current.current) URL.revokeObjectURL(file.url);
  }, []);
  return useMemo(() => ({ files, add, remove, clear, openFileDialog, fileInputRef, configure }),
    [files, add, remove, clear, openFileDialog, configure]);
}

export type PromptInputProviderProps = PropsWithChildren<{ initialInput?: string; onInputChange?: (value: string) => void }>;
export function PromptInputProvider({ initialInput = "", onInputChange, children }: PromptInputProviderProps) {
  const [value, setValue] = useState(initialInput);
  const draft = useRef<Draft>({ value: initialInput, revision: 0 });
  const onChange = useRef(onInputChange);
  onChange.current = onInputChange;
  const setInput = useCallback((next: string) => {
    draft.current = editDraft(draft.current, next);
    onChange.current?.(next);
    setValue(next);
  }, []);
  const snapshot = useCallback(() => draft.current, []);
  const clearSubmitted = useCallback((submitted: Draft) => {
    if (!submittedDraftIsCurrent(draft.current, submitted)) return false;
    setInput("");
    return true;
  }, [setInput]);
  const attachments = useAttachmentController();
  useLayoutEffect(() => attachments.files.length ? holdReload() : undefined, [attachments.files.length]);
  const controller = useMemo(() => ({ textInput: { value, setInput, snapshot, clearSubmitted }, attachments }), [value, setInput, snapshot, clearSubmitted, attachments]);
  return (
    <PromptInputController.Provider value={controller}>
      <AttachmentsContext.Provider value={attachments}>{children}</AttachmentsContext.Provider>
    </PromptInputController.Provider>
  );
}

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart & { id: string };
  className?: string;
};

export function PromptInputAttachment({
  data,
  className,
  ...props
}: PromptInputAttachmentProps) {
  const attachments = usePromptInputAttachments();

  const filename = data.filename || "";

  const mediaType =
    data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";

  const attachmentLabel = filename || (isImage ? "Image" : "Attachment");

  return (
    <PromptInputHoverCard>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
            className
          )}
          key={data.id}
          {...props}
        >
          <div className="relative size-5 shrink-0">
            <div className="absolute inset-0 flex size-5 items-center justify-center overflow-hidden rounded bg-background transition-opacity group-hover:opacity-0">
              {isImage ? (
                <img
                  alt={filename || "attachment"}
                  className="size-5 object-cover"
                  height={20}
                  src={data.url}
                  width={20}
                />
              ) : (
                <div className="flex size-5 items-center justify-center text-muted-foreground">
                  <PaperclipIcon className="size-3" />
                </div>
              )}
            </div>
            <Button
              aria-label="Remove attachment"
              className="absolute inset-0 size-5 cursor-pointer rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:opacity-100 [&>svg]:size-2.5"
              onClick={(e) => {
                e.stopPropagation();
                attachments.remove(data.id);
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">Remove</span>
            </Button>
          </div>

          <span className="flex-1 truncate">{attachmentLabel}</span>
        </div>
      </HoverCardTrigger>
      <PromptInputHoverCardContent className="w-auto p-2">
        <div className="w-auto space-y-3">
          {isImage && (
            <div className="flex max-h-96 w-96 max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden rounded-md border">
              <img
                alt={filename || "attachment preview"}
                className="max-h-full max-w-full object-contain"
                height={384}
                src={data.url}
                width={448}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="min-w-0 flex-1 space-y-1 px-0.5">
              <h4 className="truncate font-semibold text-sm leading-none">
                {filename || (isImage ? "Image" : "Attachment")}
              </h4>
              {data.mediaType && (
                <p className="truncate font-mono text-muted-foreground text-xs">
                  {data.mediaType}
                </p>
              )}
            </div>
          </div>
        </div>
      </PromptInputHoverCardContent>
    </PromptInputHoverCard>
  );
}

export type PromptInputAttachmentsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> & {
  children: (attachment: FileUIPart & { id: string }) => ReactNode;
};

export function PromptInputAttachments({
  children,
  className,
  ...props
}: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 p-3 w-full", className)}
      {...props}
    >
      {attachments.files.map((file) => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  );
}

export type PromptInputMessage = { text: string; files: AttachmentFile[] };
export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & AttachmentLimits & {
  multiple?: boolean;
  globalDrop?: boolean;
  onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | string | Promise<void | string>;
};

export const PromptInput = ({ className, accept, multiple, globalDrop, maxFiles, maxFileSize, onError, onSubmit, children, ...props }: PromptInputProps) => {
  const controller = useOptionalPromptInputController();
  const local = useAttachmentController();
  const attachments = controller?.attachments ?? local;
  const { files, add, remove, fileInputRef, configure } = attachments;
  const formRef = useRef<HTMLFormElement | null>(null);
  const submitting = useRef(false);
  const inputRevision = useRef(0);
  useLayoutEffect(() => {
    const form = formRef.current;
    const changed = () => { inputRevision.current += 1; };
    form?.addEventListener("input", changed);
    return () => form?.removeEventListener("input", changed);
  }, []);
  useLayoutEffect(() => !controller && files.length ? holdReload() : undefined, [controller, files.length]);
  // Configure the shared controller before any picker, paste, drop or external add can run.
  useLayoutEffect(() => configure({ accept, maxFiles, maxFileSize, onError }),
    [configure, accept, maxFiles, maxFileSize, onError]);

  useEffect(() => {
    const target = globalDrop ? document : formRef.current;
    if (!target) return;
    const dragover = (event: Event) => {
      if ((event as DragEvent).dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const drop = (event: Event) => {
      const transfer = (event as DragEvent).dataTransfer;
      if (!transfer?.types.includes("Files")) return;
      event.preventDefault();
      if (transfer.files.length) add(transfer.files);
    };
    target.addEventListener("dragover", dragover);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", dragover);
      target.removeEventListener("drop", drop);
    };
  }, [add, globalDrop]);

  const handleChange: ChangeEventHandler<HTMLInputElement> = event => {
    if (event.currentTarget.files) add(event.currentTarget.files);
    event.currentTarget.value = "";
  };
  const handleSubmit: FormEventHandler<HTMLFormElement> = async event => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    const form = event.currentTarget;
    const submitted = controller?.textInput.snapshot();
    const revision = inputRevision.current;
    const text = submitted?.value ?? String(new FormData(form).get("message") ?? "");
    const releaseReload = holdReload();
    try {
      let converted: AttachmentFile[];
      try {
        converted = await Promise.all(files.map(async ({ id: _id, file, ...item }) => ({
          ...item, url: await attachmentDataUrl(file),
        })));
      } catch (error) {
        onError?.({ code: "file_read", message: (error as Error).message });
        return;
      }
      const prefill = await onSubmit({ text, files: converted }, event);
      // Remove only what was sent; edits and new attachments made while waiting survive.
      for (const file of files) remove(file.id);
      if (controller) {
        if (submitted && controller.textInput.clearSubmitted(submitted) && prefill) controller.textInput.setInput(prefill);
      } else {
        const textarea = form.elements.namedItem("message");
        if (textarea instanceof HTMLTextAreaElement && textarea.value === text && inputRevision.current === revision) textarea.value = prefill || "";
      }
    } catch {
      // The caller reports send failures; retain the text and files for retry.
    } finally {
      releaseReload();
      submitting.current = false;
    }
  };
  return (
    <AttachmentsContext.Provider value={attachments}>
      <input accept={accept} aria-label="Upload files" className="hidden" multiple={multiple}
        onChange={handleChange} ref={fileInputRef} title="Upload files" type="file" />
      <form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
        <InputGroup className="overflow-hidden">{children}</InputGroup>
      </form>
    </AttachmentsContext.Provider>
  );
};

export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;

export const PromptInputTextarea = ({
  onChange,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const controller = useOptionalPromptInputController();
  const attachments = usePromptInputAttachments();
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === "Enter") {
      if (isComposing || e.nativeEvent.isComposing) {
        return;
      }
      if (e.shiftKey) {
        return;
      }
      // Portal: on a touch keyboard Enter is a newline; the send button sends.
      if (window.matchMedia("(pointer: coarse)").matches) {
        return;
      }
      e.preventDefault();

      // Check if the submit button is disabled before submitting
      const form = e.currentTarget.form;
      const submitButton = form?.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null;
      if (submitButton?.disabled) {
        return;
      }

      form?.requestSubmit();
    }

    // Remove last attachment when Backspace is pressed and textarea is empty
    if (
      e.key === "Backspace" &&
      e.currentTarget.value === "" &&
      attachments.files.length > 0
    ) {
      e.preventDefault();
      const lastAttachment = attachments.files.at(-1);
      if (lastAttachment) {
        attachments.remove(lastAttachment.id);
      }
    }
  };

  const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = (event) => {
    const items = event.clipboardData?.items;

    if (!items) {
      return;
    }

    const files: File[] = [];

    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      attachments.add(files);
    }
  };

  const controlledProps = controller
    ? {
        value: controller.textInput.value,
        onChange: (e: ChangeEvent<HTMLTextAreaElement>) => {
          controller.textInput.setInput(e.currentTarget.value);
          onChange?.(e);
        },
      }
    : {
        onChange,
      };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-48 min-h-16", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder={placeholder}
      {...props}
      {...controlledProps}
    />
  );
};

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputButton = ({
  variant = "ghost",
  className,
  size,
  ...props
}: PromptInputButtonProps) => {
  const newSize =
    size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

  return (
    <InputGroupButton
      className={cn(className)}
      size={newSize}
      type="button"
      variant={variant}
      {...props}
    />
  );
};

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  return (
    <InputGroupButton
      aria-label="Submit"
      className={cn(className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type PromptInputHoverCardContentProps = ComponentProps<
  typeof HoverCardContent
>;

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => (
  <HoverCardContent align={align} {...props} />
);
