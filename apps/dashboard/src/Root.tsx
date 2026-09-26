import { useEffect, useState } from "react";
import App from "./App";
import EnginesPage from "./app/engines/page";

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? "/dashboard" : hash;
}

export function Root() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (route === "/engines") return <EnginesPage />;
  return <App />;
}

export default Root;
