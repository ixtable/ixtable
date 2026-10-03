import { Save, Shapes } from "lucide-react";
import { useShell } from "../shell/context";
import { DesignStudio } from "./DesignStudio";

/** Design mode: the form designer, navigation editor, and in-Studio preview. */
export function DesignMode() {
  const { objects, save } = useShell();
  return (
    <>
      <header className="titlebar">
        <div>
          <p>PROJECT / DESIGN</p>
          <h1>Form builder</h1>
        </div>
        <div className="header-actions">
          <button className="save" onClick={() => save()}>
            <Save />
            Save
          </button>
        </div>
      </header>
      <DesignStudio objects={objects} />
    </>
  );
}

export function DesignSidebar() {
  return (
    <nav aria-label="Design objects">
      <button className="active">
        <Shapes />
        Forms<span>›</span>
      </button>
    </nav>
  );
}
