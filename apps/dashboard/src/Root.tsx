import { useEffect, useState } from "react";
import App from "./App";
import EnginesPage from "./app/engines/page";
import TeamPage from "./app/team/page";

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash === "" ? "/team" : hash;
}

export function Root() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (route === "/engines") return <EnginesPage />;
  if (route === "/team" || route === "/") return <TeamPage />;
  return <App />;
}

export default Root;
