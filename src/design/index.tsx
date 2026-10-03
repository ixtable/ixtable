import { Save, Shapes } from "lucide-react";
import { useState } from "react";
import { useShell } from "../shell/context";
import { DesignStudio } from "./DesignStudio";

/** Design mode: the form builder and its in-Studio preview. */
export function DesignMode() {
  const { doc, objects, save } = useShell();
  const [preview, setPreview] = useState(false);
  return (
    <>
      <header className="titlebar">
        <div>
          <p>PROJECT / DESIGN</p>
          <h1>{preview ? doc.name : "Form builder"}</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setPreview((value) => !value)}>
            {preview ? "Back to editor" : "Preview app"}
          </button>
          <button className="save" onClick={() => save()}>
            <Save />
            Save
          </button>
        </div>
      </header>
      <DesignStudio preview={preview} objects={objects} />
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
