import {initializeApp} from 'firebase/app';
import {EmailAuthProvider,browserLocalPersistence,getAuth,onAuthStateChanged,reauthenticateWithCredential,setPersistence,signInWithEmailAndPassword,signOut,updatePassword,type Auth} from 'firebase/auth';

const config={
 apiKey:import.meta.env.VITE_FIREBASE_API_KEY,
 authDomain:import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
 projectId:import.meta.env.VITE_FIREBASE_PROJECT_ID,
 storageBucket:import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
 messagingSenderId:import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
 appId:import.meta.env.VITE_FIREBASE_APP_ID
};
// Only public web-app identifiers live here. Service-account credentials exist solely in the server environment.
export const firebaseConfigured=Boolean(config.apiKey&&config.authDomain&&config.projectId&&config.appId);
const auth:Auth|null=firebaseConfigured?getAuth(initializeApp(config)):null;
const NOT_CONFIGURED='Firebase is not configured for this build. Set the VITE_FIREBASE_* environment variables and redeploy.';

const codeOf=(e:unknown)=>(typeof e==='object'&&e&&'code' in e?String((e as {code:unknown}).code):'');
const friendly=(e:unknown,fallback:string)=>{
 switch(codeOf(e)){
  case 'auth/invalid-credential':case 'auth/wrong-password':case 'auth/user-not-found':case 'auth/invalid-email':return 'Incorrect email or password.';
  case 'auth/user-disabled':return 'This account has been disabled. Contact an administrator.';
  case 'auth/too-many-requests':return 'Too many attempts. Wait a few minutes and try again.';
  case 'auth/network-request-failed':return 'We couldn’t reach the sign-in service. Check your connection and try again.';
  default:return fallback;
 }
};

/** Fires with true/false whenever Firebase restores, creates or ends a session (including after a page refresh). */
export function watchAuth(cb:(signedIn:boolean)=>void){
 if(!auth){cb(false);return()=>{}}
 return onAuthStateChanged(auth,u=>cb(!!u));
}
export async function signInWithEmail(email:string,password:string){
 if(!auth)throw Error(NOT_CONFIGURED);
 try{await setPersistence(auth,browserLocalPersistence);await signInWithEmailAndPassword(auth,email.trim(),password)}
 catch(e){throw Error(friendly(e,'We couldn’t sign you in. Check your email and password, then try again.'))}
}
export const signOutUser=async()=>{if(auth)await signOut(auth)};
/** Returns a valid ID token; the SDK refreshes it automatically when it is close to expiry. */
export async function getIdToken(forceRefresh=false){
 const u=auth?.currentUser;
 return u?u.getIdToken(forceRefresh):null;
}
export async function changeOwnPassword(current:string,next:string){
 const u=auth?.currentUser;
 if(!u||!u.email)throw Error('Please sign in again to change your password.');
 if(current===next)throw Error('Choose a password that is different from your current one.');
 try{
  await reauthenticateWithCredential(u,EmailAuthProvider.credential(u.email,current));
  await updatePassword(u,next);
 }catch(e){
  const c=codeOf(e);
  if(c==='auth/invalid-credential'||c==='auth/wrong-password')throw Error('Current password is incorrect.');
  if(c==='auth/weak-password')throw Error('That password is too weak. Use at least 12 characters.');
  if(c==='auth/requires-recent-login')throw Error('For security, sign out and sign in again, then change your password.');
  throw Error(friendly(e,'Could not change password. Try again in a moment.'));
 }
}
