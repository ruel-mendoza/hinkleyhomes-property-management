import { useState, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronLeft,
  House,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { useSignIn, useSignUp } from "@clerk/react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useValidateSignupEmail } from "@workspace/api-client-react";
import { isAllowedStaffEmail } from "@/lib/staff-email";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import "./auth.css";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const restrictedEmailMessage =
  "Access restricted: Only @hinkleyhomes.co.uk email addresses are allowed to register.";

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function Brand() {
  return (
    <Link href="/" className="auth-brand" data-testid="link-auth-brand">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" />
      <span>
        <strong>Hinkley Homes</strong>
        <small>Property operations</small>
      </span>
    </Link>
  );
}

function AuthLayout({
  children,
  page,
}: {
  children: ReactNode;
  page: "welcome" | "login" | "signup";
}) {
  return (
    <div className={`auth-layout auth-layout-${page}`}>
      <section className="auth-story" aria-label="Hinkley Homes staff portal">
        <Brand />
        <div className="auth-story-content">
          <div className="auth-story-kicker">
            <span className="auth-kicker-dot" />
            STAFF PROPERTY OPERATIONS
          </div>
          <h1>Make every property day run smoothly.</h1>
          <p>
            A single, secure workspace for tenancies, maintenance, property activity, and
            the teams who keep Hinkley Homes moving.
          </p>
          <div className="auth-story-card">
            <div className="auth-story-card-icon">
              <CalendarDays size={17} />
            </div>
            <div>
              <strong>One clear view of the day</strong>
              <span>Bookings, arrivals, and property activity together.</span>
            </div>
            <CheckCircle2 size={17} className="auth-story-check" />
          </div>
        </div>
        <div className="auth-story-footer">
          <ShieldCheck size={14} />
          Restricted to Hinkley Homes staff
        </div>
      </section>
      <main className="auth-main">
        <div className="auth-mobile-brand"><Brand /></div>
        <div className="auth-panel">{children}</div>
        <div className="auth-main-footer">Hinkley Homes · Staff portal</div>
      </main>
    </div>
  );
}

function AuthHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="auth-heading">
      <span className="auth-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

function AuthError({ children }: { children: string }) {
  return (
    <div className="auth-error" role="alert" data-testid="auth-error">
      <span aria-hidden="true">!</span>
      {children}
    </div>
  );
}

function AuthSubmit({
  busy,
  children,
  testId,
}: {
  busy: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <button
      className="auth-submit"
      type="submit"
      disabled={busy}
      data-testid={testId}
    >
      {busy ? <LoaderCircle size={16} className="auth-spinner" /> : children}
    </button>
  );
}

export function AuthLandingPage() {
  return (
    <AuthLayout page="welcome">
      <div className="auth-welcome-mark"><House size={19} /></div>
      <AuthHeading
        eyebrow="WELCOME TO YOUR WORKSPACE"
        title="Hinkley Homes PMS"
        description="Sign in with your company email. We'll send you a code, so there's no password to remember."
      />
      <div className="auth-welcome-actions">
        <Link
          className="auth-submit"
          href="/sign-in"
          data-testid="link-sign-in"
        >
          Sign in <ArrowRight size={16} />
        </Link>
      </div>
      <div className="auth-restriction-note">
        <LockKeyhole size={14} />
        Only @hinkleyhomes.co.uk addresses can sign in.
      </div>
    </AuthLayout>
  );
}

const emailSchema = z.object({
  email: z
    .string()
    .trim()
    .email("Enter a valid email address.")
    .refine(isAllowedStaffEmail, restrictedEmailMessage),
});
type EmailValues = z.infer<typeof emailSchema>;

const nameSchema = z.object({
  fullName: z.string().trim().min(2, "Enter your full name."),
});
type NameValues = z.infer<typeof nameSchema>;

const codeSchema = z.object({
  code: z.string().trim().min(4, "Enter the code from your email."),
});
type CodeValues = z.infer<typeof codeSchema>;

// Clerk API errors carry a stable code on the first entry of `errors`.
function clerkErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const list = (error as { errors?: Array<{ code?: unknown }> }).errors;
  const code = list?.[0]?.code ?? (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

const emailCodesOffMessage =
  "Email codes aren't switched on for this portal yet. Ask your administrator.";

// One page for everyone: email, then name (first visit only), then the emailed code.
export function SignInPage() {
  const { signIn, fetchStatus: signInStatus } = useSignIn();
  const { signUp, fetchStatus: signUpStatus } = useSignUp();
  const [, setLocation] = useLocation();
  const [authError, setAuthError] = useState("");
  const [stage, setStage] = useState<"email" | "name" | "code">("email");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");
  const validateEmail = useValidateSignupEmail();
  const emailForm = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
    defaultValues: { email: "" },
  });
  const nameForm = useForm<NameValues>({
    resolver: zodResolver(nameSchema),
    defaultValues: { fullName: "" },
  });
  const codeForm = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: "" },
  });
  const busy =
    signInStatus === "fetching" ||
    signUpStatus === "fetching" ||
    validateEmail.isPending;

  const navigateToDashboard = ({
    decorateUrl,
  }: {
    decorateUrl: (url: string) => string;
  }) => {
    const target = decorateUrl(`${basePath}/dashboard`);
    if (target.startsWith("http")) {
      window.location.href = target;
    } else {
      setLocation(stripBase(target));
    }
  };

  const showCodeStage = (nextMode: "signIn" | "signUp") => {
    setMode(nextMode);
    codeForm.reset({ code: "" });
    setStage("code");
  };

  const sendSignInCode = async (address: string): Promise<"sent" | "new" | "failed"> => {
    const { error } = await signIn.emailCode.sendCode({ emailAddress: address });
    if (!error) return "sent";
    const code = clerkErrorCode(error);
    if (code === "form_identifier_not_found") return "new";
    setAuthError(
      code === "strategy_for_user_invalid"
        ? emailCodesOffMessage
        : errorMessage(error, "Could not send a sign-in code."),
    );
    return "failed";
  };

  const submitEmail = async (values: EmailValues) => {
    setAuthError("");
    setNotice("");
    const address = values.email.trim();

    try {
      const domainCheck = await validateEmail.mutateAsync({ data: { email: address } });
      if (!domainCheck.allowed) {
        emailForm.setError("email", {
          type: "server",
          message: domainCheck.message || restrictedEmailMessage,
        });
        return;
      }
    } catch (error) {
      setAuthError(errorMessage(error, "We could not check this email. Please try again."));
      return;
    }

    setEmail(address);
    const result = await sendSignInCode(address);
    if (result === "sent") showCodeStage("signIn");
    if (result === "new") setStage("name");
  };

  const submitName = async (values: NameValues) => {
    setAuthError("");
    const { error } = await signUp.create({
      emailAddress: email,
      unsafeMetadata: { fullName: values.fullName.trim() },
    });
    if (error) {
      // Someone finished signing up with this email meanwhile: sign them in instead.
      if (clerkErrorCode(error) === "form_identifier_exists") {
        if ((await sendSignInCode(email)) === "sent") showCodeStage("signIn");
        return;
      }
      setAuthError(errorMessage(error, "Could not set up your access."));
      return;
    }
    const sent = await signUp.verifications.sendEmailCode();
    if (sent.error) {
      setAuthError(errorMessage(sent.error, "Could not send a sign-in code."));
      return;
    }
    showCodeStage("signUp");
  };

  const submitCode = async (values: CodeValues) => {
    setAuthError("");
    const code = values.code.trim();

    if (mode === "signIn") {
      const { error } = await signIn.emailCode.verifyCode({ code });
      if (error) {
        setAuthError(errorMessage(error, "That code could not be confirmed."));
        return;
      }
      if (signIn.status !== "complete") {
        setAuthError("This account needs an extra sign-in step. Ask your administrator.");
        return;
      }
      const { error: finalizeError } = await signIn.finalize({ navigate: navigateToDashboard });
      if (finalizeError) setAuthError(errorMessage(finalizeError, "Could not finish signing in."));
      return;
    }

    const { error } = await signUp.verifications.verifyEmailCode({ code });
    if (error) {
      setAuthError(errorMessage(error, "That code could not be confirmed."));
      return;
    }
    if (signUp.status !== "complete") {
      setAuthError(
        signUp.missingFields.includes("password")
          ? "Passwords are still required for this portal. Ask your administrator to switch them off."
          : "Your access isn't ready yet. Send a new code and try again.",
      );
      return;
    }
    const { error: finalizeError } = await signUp.finalize({ navigate: navigateToDashboard });
    if (finalizeError) setAuthError(errorMessage(finalizeError, "Could not finish signing in."));
  };

  const resendCode = async () => {
    setAuthError("");
    setNotice("");
    const { error } =
      mode === "signIn"
        ? await signIn.emailCode.sendCode()
        : await signUp.verifications.sendEmailCode();
    if (error) setAuthError(errorMessage(error, "Could not send a new code."));
    else setNotice("A new code is on its way.");
  };

  const startAgain = () => {
    setAuthError("");
    setNotice("");
    void signIn.reset();
    void signUp.reset();
    nameForm.reset({ fullName: "" });
    setStage("email");
  };

  const heading =
    stage === "code"
      ? { title: "Check your email", description: `Enter the code we sent to ${email}.` }
      : stage === "name"
        ? { title: "First time here?", description: `Tell us your name to set up access for ${email}.` }
        : { title: "Sign in", description: "Enter your company email and we'll send you a code." };

  return (
    <AuthLayout page="login">
      <Link className="auth-back-link" href="/" data-testid="link-auth-home">
        <ChevronLeft size={15} /> Home
      </Link>
      <AuthHeading eyebrow="STAFF ACCESS" {...heading} />
      {authError && <AuthError>{authError}</AuthError>}
      {notice && !authError && (
        <div className="auth-restriction-note" role="status" data-testid="auth-notice">
          <Check size={14} /> {notice}
        </div>
      )}

      {stage === "email" && (
        <Form {...emailForm}>
          <form className="auth-form" onSubmit={emailForm.handleSubmit(submitEmail)} noValidate>
            <FormField
              control={emailForm.control}
              name="email"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Company email</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      type="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      autoFocus
                      placeholder="name@hinkleyhomes.co.uk"
                      data-testid="input-signin-email"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <AuthSubmit busy={busy} testId="button-send-code">
              Email me a code <ArrowRight size={16} />
            </AuthSubmit>
          </form>
        </Form>
      )}

      {stage === "name" && (
        <Form {...nameForm}>
          <form className="auth-form" onSubmit={nameForm.handleSubmit(submitName)} noValidate>
            <FormField
              control={nameForm.control}
              name="fullName"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Full name</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input"
                      autoComplete="name"
                      autoFocus
                      placeholder="Your full name"
                      data-testid="input-signin-full-name"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <div id="clerk-captcha" data-testid="signup-captcha-slot" />
            <AuthSubmit busy={busy} testId="button-send-code-new">
              Email me a code <ArrowRight size={16} />
            </AuthSubmit>
            <button type="button" className="auth-text-button" onClick={startAgain} data-testid="button-change-email">
              Use a different email
            </button>
          </form>
        </Form>
      )}

      {stage === "code" && (
        <Form {...codeForm}>
          <form className="auth-form" onSubmit={codeForm.handleSubmit(submitCode)} noValidate>
            <FormField
              control={codeForm.control}
              name="code"
              render={({ field }) => (
                <FormItem className="auth-field">
                  <FormLabel className="auth-label">Code</FormLabel>
                  <FormControl>
                    <input
                      {...field}
                      className="auth-input auth-code-input"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      autoFocus
                      placeholder="6-digit code"
                      data-testid="input-signin-code"
                    />
                  </FormControl>
                  <FormMessage className="auth-field-error" />
                </FormItem>
              )}
            />
            <AuthSubmit busy={busy} testId="button-verify-code">
              Sign in <ArrowRight size={16} />
            </AuthSubmit>
            <button type="button" className="auth-text-button" onClick={resendCode} disabled={busy} data-testid="button-resend-code">
              Send a new code
            </button>
            <button type="button" className="auth-text-button" onClick={startAgain} data-testid="button-change-email">
              Use a different email
            </button>
          </form>
        </Form>
      )}

      <div className="auth-security-foot">
        <Mail size={13} /> No password needed · you stay signed in for 7 days
      </div>
    </AuthLayout>
  );
}

export function AccessRestrictedPage({
  onSignOut,
}: {
  onSignOut: () => void;
}) {
  return (
    <AuthLayout page="login">
      <div className="auth-welcome-mark"><LockKeyhole size={18} /></div>
      <AuthHeading
        eyebrow="ACCESS RESTRICTED"
        title="This staff portal is private"
        description={restrictedEmailMessage}
      />
      <button
        className="auth-submit"
        type="button"
        onClick={onSignOut}
        data-testid="button-restricted-signout"
      >
        Sign out <ArrowRight size={16} />
      </button>
    </AuthLayout>
  );
}

export function AuthLoadingPage() {
  return (
    <div className="auth-loading" role="status" data-testid="auth-loading">
      <LoaderCircle size={22} className="auth-spinner" />
      <span>Loading your secure workspace…</span>
    </div>
  );
}

