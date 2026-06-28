import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import { Download, Power, RefreshCw, X } from "lucide-react";
import type { UpdateState } from "@dinorip/ipc-contracts";

interface UpdateIndicatorProps {
  state: UpdateState;
  onOpen(): void;
}

interface UpdateModalProps {
  state: UpdateState;
  onClose(): void;
  onPrimaryAction(): void;
}

export function getUpdateVersion(state: UpdateState | null): string | null {
  return state?.downloadedVersion ?? state?.availableVersion ?? null;
}

export function isUpdateActionable(state: UpdateState | null): state is UpdateState {
  if (!state || !state.enabled) return false;
  if (state.status === "available" || state.status === "downloading" || state.status === "downloaded") {
    return true;
  }
  return state.status === "error" && state.canRetry;
}

export function shouldShowUpdateModal(state: UpdateState | null, dismissedVersion: string | null): state is UpdateState {
  if (!isUpdateActionable(state)) return false;
  const version = getUpdateVersion(state);
  return version !== null && version !== dismissedVersion;
}

export function UpdateIndicator({ state, onOpen }: UpdateIndicatorProps): ReactElement {
  return (
    <button
      type="button"
      className="update-pill"
      onClick={onOpen}
      title={getIndicatorTitle(state)}
      aria-label={getIndicatorTitle(state)}
    >
      <span className="update-pill__dot" aria-hidden="true" />
      <span className="update-pill__label">{getIndicatorLabel(state)}</span>
    </button>
  );
}

export function UpdateModal({ state, onClose, onPrimaryAction }: UpdateModalProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const onCloseRef = useRef(onClose);
  const progress = getProgressPercent(state);
  const progressStyle = { "--update-progress": `${progress}%` } as CSSProperties;
  const PrimaryIcon = getPrimaryIcon(state);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener("cancel", onCancel);
    if (!dialog.open) dialog.showModal();
    return () => {
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
    };
  }, []);

  const closeFromBackdrop = (event: ReactPointerEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return createPortal(
    <dialog ref={dialogRef} className="shortcuts-overlay update-overlay" aria-label="DinoRip update" onPointerDown={closeFromBackdrop}>
      <div className="update-modal">
        <header className="shortcuts-modal__header">
          <h2>{getModalTitle(state)}</h2>
          <span className="shortcuts-modal__hint">{getVersionHint(state)}</span>
          <button
            type="button"
            className="shortcuts-modal__close"
            onClick={onClose}
            aria-label="Close update dialog"
          >
            <X size={14} />
          </button>
        </header>
        <div className="update-modal__body">
          <p className="update-modal__lead">{getLeadCopy(state)}</p>
          <p className="update-modal__notes">{getSecondaryCopy(state)}</p>
          {state.message && state.status === "error" ? (
            <p className="update-modal__error">{state.message}</p>
          ) : null}
        </div>
        <footer className="update-modal__footer">
          <button
            type="button"
            className="update-cta"
            data-status={state.status}
            style={progressStyle}
            onClick={onPrimaryAction}
            disabled={state.status === "downloading"}
          >
            <span className="update-cta__fill" aria-hidden="true" />
            <span className="update-cta__label">
              <PrimaryIcon size={14} />
              {getPrimaryLabel(state)}
            </span>
          </button>
        </footer>
      </div>
    </dialog>,
    document.body
  );
}

function getProgressPercent(state: UpdateState): number {
  if (state.status === "downloaded") return 100;
  if (state.status !== "downloading") return 0;
  return Math.max(0, Math.min(100, Math.floor(state.downloadPercent ?? 0)));
}

function getPrimaryIcon(state: UpdateState) {
  if (state.status === "downloaded" || state.errorContext === "install") return Power;
  if (state.status === "error" || state.errorContext === "download") return RefreshCw;
  return Download;
}

function getPrimaryLabel(state: UpdateState): string {
  if (state.status === "downloading") {
    return `Downloading... ${getProgressPercent(state)}%`;
  }
  if (state.status === "downloaded" || state.errorContext === "install") {
    return "Restart and Install";
  }
  if (state.status === "error" || state.errorContext === "download") {
    return "Retry Update";
  }
  return "Download and Install";
}

function getModalTitle(state: UpdateState): string {
  if (state.status === "downloaded") return "Update ready";
  if (state.status === "error") return "Update needs attention";
  return "Update available";
}

function getVersionHint(state: UpdateState): string {
  const version = getUpdateVersion(state);
  return version ? `v${version}` : `v${state.currentVersion}`;
}

function getLeadCopy(state: UpdateState): string {
  const version = getUpdateVersion(state) ?? "the latest version";
  if (state.status === "downloaded") {
    return `DinoRip ${version} has downloaded and is ready to install.`;
  }
  if (state.status === "downloading") {
    return `Downloading DinoRip ${version}.`;
  }
  if (state.status === "error") {
    return "The update did not finish.";
  }
  return `DinoRip ${version} is available.`;
}

function getSecondaryCopy(state: UpdateState): string {
  if (state.status === "downloaded") {
    return "Installing will restart DinoRip. Save any open project changes before continuing.";
  }
  if (state.status === "downloading") {
    return "The button fills as the download progresses. You can keep working while DinoRip gets the update ready.";
  }
  if (state.status === "error" && state.errorContext === "install") {
    return "The update is downloaded, but DinoRip could not restart into the installer.";
  }
  if (state.status === "error") {
    return "Check your connection, then retry the update.";
  }
  return "Download it now, or close this window and use the update notice in the top bar later.";
}

function getIndicatorLabel(state: UpdateState): string {
  if (state.status === "downloading") return `Downloading ${getProgressPercent(state)}%`;
  if (state.status === "downloaded") return "Update ready";
  if (state.status === "error") return "Update issue";
  return "Update available";
}

function getIndicatorTitle(state: UpdateState): string {
  const version = getUpdateVersion(state);
  if (state.status === "error") {
    return "DinoRip could not check for updates.";
  }
  if (state.status === "downloaded") {
    return `DinoRip ${version ?? "update"} is ready to install.`;
  }
  if (state.status === "downloading") {
    return `Downloading DinoRip ${version ?? "update"} (${getProgressPercent(state)}%).`;
  }
  return `DinoRip ${version ?? "update"} is available. Open updater.`;
}
