export const SCAD_LIBRARY = `
// --- STANDARD LIBRARY (INJECTED) ---
// Units are millimetres. Your own code may override $fn.
$fn = 64;

// 1. A TUBE / CUP
// Closed bottom of thickness \`wall\`, open top. center=true centres it on Z.
module Tube(height, radius, wall, center = false) {
    translate([0, 0, center ? -height / 2 : 0])
    difference() {
        cylinder(h = height, r = radius);
        translate([0, 0, wall])
            cylinder(h = height, r = radius - wall);
    }
}

// 2. A ROUNDED BOX, centred on the origin. size = [x, y, z].
module SoftBox(size, radius) {
    minkowski() {
        cube(size - [radius*2, radius*2, radius*2], center=true);
        sphere(r=radius);
    }
}

// 3. A MUG HANDLE
// A ring sunk into the side of a mug of radius mug_radius, centred at height
// z_center. Anything inside the mug's inner wall (mug_radius - wall) is cut away.
module ArcHandle(mug_radius, handle_radius, thickness, z_center, wall = 4) {
    translate([0, 0, z_center])
    difference() {
        translate([mug_radius - thickness/2, 0, 0])
        rotate([90, 0, 0])
        rotate_extrude(angle = 360)
            translate([handle_radius, 0])
            circle(d = thickness);

        cylinder(h=200, r=mug_radius - wall, center=true);
    }
}
`;

export const SCAD_LIBRARY_DOC = `Standard library, already included in every file (units: mm):
- Tube(height, radius, wall, center=false): cup with a closed bottom and open top.
- SoftBox(size, radius): rounded box centred on the origin; size is [x, y, z].
- ArcHandle(mug_radius, handle_radius, thickness, z_center, wall=4): mug handle ring.`;

// Lines the library adds before the model's code, so OpenSCAD's line numbers
// can be mapped back to the model's own lines.
export const LIBRARY_HEADER = `${SCAD_LIBRARY}\n// --- AI GENERATED CODE ---\n`;
export const LIBRARY_LINE_COUNT = LIBRARY_HEADER.split("\n").length - 1;
