"use client";

import { useEffect, useRef, useState } from "react";

type GoogleCredentialResponse = { credential?: string };
type GoogleIdentity = {
  accounts: {
    id: {
      initialize: (options: {
        client_id: string;
        callback: (response: GoogleCredentialResponse) => void;
        auto_select?: boolean;
        ux_mode?: "popup" | "redirect";
      }) => void;
      renderButton: (
        element: HTMLElement,
        options: { theme: "outline"; size: "large"; text: "signin_with" | "signup_with"; shape: "rectangular"; width: number },
      ) => void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

const GOOGLE_CLIENT_ID = String(import.meta.env.VITE_GOOGLE_CLIENT_ID || "616903528757-on8f6ar866ehcvu8m022itlr03aquvgd.apps.googleusercontent.com").trim();
const GOOGLE_SCRIPT_ID = "nightbox-google-identity-services";

function loadGoogleIdentity(): Promise<boolean> {
  if (window.google?.accounts.id) return Promise.resolve(true);

  return new Promise((resolve) => {
    let script = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    const onLoad = () => resolve(Boolean(window.google?.accounts.id));
    const onError = () => resolve(false);

    if (!script) {
      script = document.createElement("script");
      script.id = GOOGLE_SCRIPT_ID;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
      document.head.appendChild(script);
      return;
    }

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
  });
}

export default function GoogleSignInButton({ onCredential, mode }: { onCredential: (credential: string) => Promise<void>; mode: "signin" | "signup" }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const callbackRef = useRef(onCredential);
  const [error, setError] = useState("");

  useEffect(() => {
    callbackRef.current = onCredential;
  }, [onCredential]);

  useEffect(() => {
    let active = true;
    const button = buttonRef.current;

    void loadGoogleIdentity().then((loaded) => {
      if (!active || !button) return;
      if (!loaded || !window.google?.accounts.id) {
        setError("Google sign-in could not load. Please try again.");
        return;
      }

      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => {
          if (response.credential) void callbackRef.current(response.credential);
          else setError("Google did not return a sign-in credential.");
        },
        auto_select: false,
        ux_mode: "popup",
      });
      window.google.accounts.id.renderButton(button, {
        theme: "outline",
        size: "large",
        text: mode === "signup" ? "signup_with" : "signin_with",
        shape: "rectangular",
        width: 320,
      });
    });

    return () => {
      active = false;
      button?.replaceChildren();
    };
  }, [mode]);

  return <div className="google-signin-wrap">
    <div className="google-signin-button" ref={buttonRef} />
    {error && <small className="google-signin-error" role="status">{error}</small>}
  </div>;
}
